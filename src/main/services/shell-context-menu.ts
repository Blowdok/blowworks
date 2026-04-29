import koffi from 'koffi'

// Affiche le menu contextuel SHELL Windows (le vrai, avec toutes les
// extensions installées : 7-Zip, Git, "Ouvrir avec…", "Propriétés",
// "Partager…", etc.) sur un fichier ou dossier, au point écran spécifié,
// et exécute la commande choisie par l'utilisateur.
//
// Stack technique :
//   1. SHParseDisplayName        : path UTF-16 → PIDL absolu
//   2. SHBindToParent            : PIDL absolu → IShellFolder parent + child PIDL
//   3. IShellFolder::GetUIObjectOf → IContextMenu pour l'item
//   4. CreatePopupMenu + IContextMenu::QueryContextMenu (CMF_EXTENDEDVERBS)
//   5. TrackPopupMenuEx(TPM_RETURNCMD) → bloque, retourne l'idCmd choisi
//   6. IContextMenu::InvokeCommand avec la verb numérique
//   7. cleanup (Release, ILFree, DestroyMenu)
//
// COM apartment : CoInitializeEx avec STA — les shell extensions exigent
// STA (Single-Threaded Apartment). Le main process Electron a déjà sa
// propre boucle de messages, donc TrackPopupMenuEx peut peinturer le
// menu et capturer les inputs sans soucis de threading.

// ── DLL & types ──────────────────────────────────────────────────────

const ole32 = koffi.load('ole32.dll')
const shell32 = koffi.load('shell32.dll')
const user32 = koffi.load('user32.dll')

// GUID = struct 16 octets { uint32, uint16, uint16, uint8[8] }. On le
// déclare comme alias buffer car koffi ne nous demande pas de struct
// quand on passe par pointeur opaque ; on construit le buffer brut
// puis on passe un `void *` à la fonction.
function makeGuid(s: string): Buffer {
  // Format attendu : "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
  const hex = s.replace(/-/g, '')
  if (hex.length !== 32) throw new Error('GUID invalide')
  const buf = Buffer.alloc(16)
  buf.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  buf.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  buf.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  for (let i = 0; i < 8; i++) {
    buf.writeUInt8(parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16), 8 + i)
  }
  return buf
}

const IID_IShellFolder = makeGuid('000214E6-0000-0000-C000-000000000046')
const IID_IContextMenu = makeGuid('000214E4-0000-0000-C000-000000000046')

// ── Fonctions Win32 ──────────────────────────────────────────────────

// CoInitializeEx(NULL, COINIT_APARTMENTTHREADED) initialise STA.
// Idempotent : retourne S_FALSE si déjà initialisé sur le thread.
const CoInitializeEx = ole32.func(
  '__stdcall',
  'CoInitializeEx',
  'long',
  ['void *', 'uint32']
)
const CoUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])

// SHParseDisplayName(pszName, pbc, ppidl, sfgaoIn, psfgaoOut)
const SHParseDisplayName = shell32.func(
  '__stdcall',
  'SHParseDisplayName',
  'long',
  ['str16', 'void *', 'void *', 'uint32', 'void *']
)

// SHBindToParent(pidl, riid, ppv, ppidlLast)
const SHBindToParent = shell32.func(
  '__stdcall',
  'SHBindToParent',
  'long',
  ['void *', 'void *', 'void *', 'void *']
)

// CoTaskMemFree pour libérer les PIDL absolus alloués par SHParseDisplayName.
// (ILFree n'est plus exporté nominalement sur tous les OS — CoTaskMemFree
// est l'équivalent fonctionnel pour les buffers alloués via
// CoTaskMemAlloc, ce qui inclut les PIDL.)
const CoTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])

const CreatePopupMenu = user32.func(
  '__stdcall',
  'CreatePopupMenu',
  'void *',
  []
)
const DestroyMenu = user32.func('__stdcall', 'DestroyMenu', 'bool', ['void *'])

// TrackPopupMenuEx(hMenu, fuFlags, x, y, hWnd, lptpm) → BOOL/int (cmd id si TPM_RETURNCMD)
const TrackPopupMenuEx = user32.func(
  '__stdcall',
  'TrackPopupMenuEx',
  'int',
  ['void *', 'uint32', 'int', 'int', 'void *', 'void *']
)

const SetForegroundWindow = user32.func(
  '__stdcall',
  'SetForegroundWindow',
  'bool',
  ['void *']
)

const PostMessageW = user32.func(
  '__stdcall',
  'PostMessageW',
  'bool',
  ['void *', 'uint', 'unsigned long long', 'long long']
)

// ── Constantes ───────────────────────────────────────────────────────

const COINIT_APARTMENTTHREADED = 0x2
const SW_SHOWNORMAL = 1

// CMF flags pour QueryContextMenu : NORMAL = items de base, EXTENDEDVERBS
// = items "Show more options" (Win11) ou items shift+rclick traditionnels.
const CMF_NORMAL = 0x00000000
const CMF_EXTENDEDVERBS = 0x00000100

// TrackPopupMenu flags
const TPM_LEFTALIGN = 0x0000
const TPM_RETURNCMD = 0x0100
const TPM_RIGHTBUTTON = 0x0002

// Plage d'IDs réservée pour le menu : 1..0x7FFF. QueryContextMenu attribue
// des IDs dans cette plage, et l'idCmd retourné par TrackPopupMenuEx est
// dans cette plage. InvokeCommand attend `lpVerb = MAKEINTRESOURCE(idCmd
// - idCmdFirst)` donc on soustraira `1` (notre idCmdFirst).
const ID_CMD_FIRST = 1
const ID_CMD_LAST = 0x7fff

// Pour PostMessage WM_NULL — un hack pour réveiller la message pump si
// nécessaire après TrackPopupMenuEx. Pas critique mais évite des soucis
// de focus rare.
const WM_NULL = 0x0000

// ── Helper pour appeler les méthodes COM via vtable ──────────────────

// Une instance COM est un pointeur vers un struct dont le 1er champ est
// un pointeur vers la vtable (= tableau de pointeurs de fonctions). Pour
// appeler la N-ième méthode :
//   1. Lit *this   → adresse vtable
//   2. Lit vtable[N] → adresse de la fonction
//   3. Appelle cette fonction avec `this` comme premier argument
//      (thiscall ABI sur x64 = stdcall avec premier arg = this).
//
// IMPORTANT : les wrappers FFI obtenus via `koffi.decode(buf, pointer(proto))`
// sont STRICTS sur leurs arguments — ils refusent un BigInt brut là où
// `void *` est attendu et exigent un "external pointer". Les fonctions
// chargées via `lib.func()` sont plus tolérantes (elles acceptent BigInt
// pour `void *`). Pour éviter `TypeError: Unexpected BigInt value`, on
// convertit chaque adresse BigInt en external pointer via le helper
// `ptrFromBigInt` (Buffer 8 octets → koffi.decode → external).

const POINTER_SIZE = 8

// Convertit une adresse 64-bit (BigInt) en external pointer koffi. Le
// Buffer intermédiaire stocke la valeur de l'adresse en little-endian ;
// `koffi.decode(buf, 'void *')` lit ces 8 octets comme une adresse et
// retourne un pointer external avec cette valeur (≠ adresse du Buffer).
function ptrFromBigInt(addr: bigint): unknown {
  const buf = Buffer.alloc(POINTER_SIZE)
  buf.writeBigUInt64LE(addr, 0)
  return koffi.decode(buf, 'void *')
}

// Lit `type` à l'adresse pointée par `addr` (BigInt). Wrapper pratique
// pour les déréférences manuelles (vtable, slot, etc.).
function readAt(addr: bigint, type: string): unknown {
  return koffi.decode(ptrFromBigInt(addr), type)
}

// Lit un pointeur 64-bit à `addr` et retourne TOUJOURS un BigInt — koffi
// renvoie un Number quand la valeur tient sur 53 bits, sinon un BigInt
// (comportement inconsistent qui casse l'arithmétique mixte). On
// normalise via `BigInt(value)` qui accepte les deux.
function readPointerAt(addr: bigint): bigint {
  const v = readAt(addr, 'uint64')
  return typeof v === 'bigint' ? v : BigInt(v as number)
}

// Cache des prototypes koffi par signature (ret + args). Évite de
// reparser le proto string à chaque appel COM.
type Proto = ReturnType<typeof koffi.proto>
const protoCache = new Map<string, Proto>()

function getProto(retType: string, argTypes: string[]): Proto {
  const key = retType + '|' + argTypes.join(',')
  const cached = protoCache.get(key)
  if (cached) return cached
  // Le prototype koffi DOIT inclure un nom unique sinon koffi rejette.
  // On utilise un compteur via la taille du cache pour générer des
  // noms uniques sans collision.
  const argsStr = argTypes.length === 0 ? '' : ', ' + argTypes.join(', ')
  const protoStr = `${retType} __stdcall ComMethod_${protoCache.size}(void *thisPtr${argsStr})`
  const proto = koffi.proto(protoStr)
  protoCache.set(key, proto)
  return proto
}

// Cache des fonctions callables par (adresse, signature). Recréer un
// wrapper koffi à chaque appel coûte cher.
const fnCache = new Map<string, (...args: unknown[]) => unknown>()

function callMethod(
  comInstance: bigint,
  methodIndex: number,
  signature: { ret: string; args: string[] },
  ...callArgs: unknown[]
): unknown {
  // Lecture de la vtable : *comInstance via external pointer.
  // `readPointerAt` garantit un BigInt → l'arithmétique pour calculer
  // l'offset du slot reste cohérente (BigInt + BigInt).
  const vtableAddr = readPointerAt(comInstance)
  const fnAddr = readPointerAt(vtableAddr + BigInt(methodIndex * POINTER_SIZE))

  const cacheKey = `${fnAddr}|${signature.ret}|${signature.args.join(',')}`
  let fn = fnCache.get(cacheKey)
  if (!fn) {
    const proto = getProto(signature.ret, signature.args)
    // `koffi.decode(funcPtr, proto)` (avec proto direct, PAS koffi.pointer(proto))
    // retourne une fonction JS callable. C'est la bonne API documentée pour
    // wrapper un function pointer arbitraire (cf. doc koffi/functions).
    const fnPtr = ptrFromBigInt(fnAddr)
    fn = koffi.decode(fnPtr, proto) as (...args: unknown[]) => unknown
    fnCache.set(cacheKey, fn)
  }

  // Conversion automatique BigInt → external pointer pour tous les args
  // dont le type est `void *` (HWND, PIDL, etc.). Les autres types
  // (uint32, int) sont laissés tels quels — koffi accepte les nombres
  // pour ces types.
  const convertedArgs = callArgs.map((arg, i) => {
    if (typeof arg === 'bigint' && signature.args[i] === 'void *') {
      return ptrFromBigInt(arg)
    }
    return arg
  })

  // `this` est toujours en première position et toujours `void *`.
  const thisPtr = ptrFromBigInt(comInstance)
  return fn(thisPtr, ...convertedArgs)
}

// ── Vtable indices (offsets standardisés depuis Windows SDK) ─────────

const IUNKNOWN_RELEASE = 2

const ISHELLFOLDER_GETUIOBJECTOF = 10

const ICONTEXTMENU_QUERYCONTEXTMENU = 3
const ICONTEXTMENU_INVOKECOMMAND = 4

// ── Tracking de l'état d'init COM ────────────────────────────────────

let comInitialized = false

function ensureCom(): void {
  if (comInitialized) return
  // S_OK = 0, S_FALSE = 1 (déjà init). On accepte les deux.
  const hr = CoInitializeEx(null, COINIT_APARTMENTTHREADED) as number
  if (hr < 0) {
    throw new Error(`CoInitializeEx a échoué : 0x${(hr >>> 0).toString(16)}`)
  }
  comInitialized = true
}

// ── API publique ─────────────────────────────────────────────────────

export interface ShellMenuRequest {
  parentHwndBuffer: Buffer // BrowserWindow.getNativeWindowHandle()
  path: string             // Chemin Windows absolu (ex: C:\Users\Bob\file.txt)
  screenX: number          // Coord écran ABSOLUE en pixels
  screenY: number
}

export interface ShellMenuResult {
  ok: boolean
  // Vrai si l'utilisateur a sélectionné une commande (et qu'elle a été
  // exécutée). Faux si l'utilisateur a annulé (Escape, clic ailleurs).
  invoked: boolean
  reason?: string
}

export async function showShellContextMenu(
  req: ShellMenuRequest
): Promise<ShellMenuResult> {
  console.log(
    `[shell-ctx] showShellContextMenu path=${req.path} screen=${req.screenX},${req.screenY}`
  )
  if (process.platform !== 'win32') {
    return { ok: false, invoked: false, reason: 'plateforme-non-supportee' }
  }
  try {
    ensureCom()
  } catch (err) {
    console.error('[shell-ctx] ensureCom a échoué :', err)
    return {
      ok: false,
      invoked: false,
      reason: err instanceof Error ? err.message : String(err)
    }
  }
  // Wrapper try/catch global : un access violation côté FFI (pointeur
  // mal aligné, vtable corrompue, etc.) crash tout le main process. On
  // capture pour rapporter au renderer plutôt que de planter Electron.
  try {
    return await showShellContextMenuInternal(req)
  } catch (err) {
    console.error('[shell-ctx] exception :', err)
    return {
      ok: false,
      invoked: false,
      reason: err instanceof Error ? err.message : String(err)
    }
  }
}

async function showShellContextMenuInternal(
  req: ShellMenuRequest
): Promise<ShellMenuResult> {

  // HWND parent depuis le buffer Electron.
  const parentHwnd = req.parentHwndBuffer.readBigUInt64LE(0)

  // 1. Parse path → PIDL absolu.
  // Out param `ppidl` : on alloue un buffer 8 octets pour recevoir le pointeur.
  const pidlAbsBuf = Buffer.alloc(POINTER_SIZE)
  const hr1 = SHParseDisplayName(req.path, null, pidlAbsBuf, 0, null) as number
  console.log(`[shell-ctx] SHParseDisplayName hr=0x${(hr1 >>> 0).toString(16)}`)
  if (hr1 < 0) {
    return {
      ok: false,
      invoked: false,
      reason: `SHParseDisplayName HRESULT=0x${(hr1 >>> 0).toString(16)}`
    }
  }
  const pidlAbs = pidlAbsBuf.readBigUInt64LE(0)
  if (pidlAbs === 0n) {
    return { ok: false, invoked: false, reason: 'pidl-null' }
  }

  // 2. Récupère IShellFolder parent + child PIDL.
  const parentFolderBuf = Buffer.alloc(POINTER_SIZE)
  const childPidlBuf = Buffer.alloc(POINTER_SIZE)
  const hr2 = SHBindToParent(
    pidlAbs,
    IID_IShellFolder,
    parentFolderBuf,
    childPidlBuf
  ) as number
  console.log(`[shell-ctx] SHBindToParent hr=0x${(hr2 >>> 0).toString(16)}`)
  if (hr2 < 0) {
    CoTaskMemFree(pidlAbs)
    return {
      ok: false,
      invoked: false,
      reason: `SHBindToParent HRESULT=0x${(hr2 >>> 0).toString(16)}`
    }
  }
  const parentFolder = parentFolderBuf.readBigUInt64LE(0)
  const childPidl = childPidlBuf.readBigUInt64LE(0)
  console.log(
    `[shell-ctx] parentFolder=0x${parentFolder.toString(16)} childPidl=0x${childPidl.toString(16)}`
  )

  // 3. GetUIObjectOf(hwnd, 1, &childPidl, IID_IContextMenu, NULL, &ppv)
  // On doit fournir un tableau de pointeurs PIDL — ici 1 seul item, donc
  // un Buffer 8 octets contenant le childPidl.
  const childPidlArrayBuf = Buffer.alloc(POINTER_SIZE)
  childPidlArrayBuf.writeBigUInt64LE(childPidl, 0)

  const ctxMenuBuf = Buffer.alloc(POINTER_SIZE)
  const hr3 = callMethod(
    parentFolder,
    ISHELLFOLDER_GETUIOBJECTOF,
    {
      ret: 'long',
      // hwndOwner, cidl, apidl, riid, rgfReserved, ppv
      args: ['void *', 'uint32', 'void *', 'void *', 'void *', 'void *']
    },
    parentHwnd,
    1,
    childPidlArrayBuf,
    IID_IContextMenu,
    null,
    ctxMenuBuf
  ) as number
  console.log(`[shell-ctx] GetUIObjectOf hr=0x${(hr3 >>> 0).toString(16)}`)
  if (hr3 < 0) {
    callMethod(parentFolder, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
    CoTaskMemFree(pidlAbs)
    return {
      ok: false,
      invoked: false,
      reason: `GetUIObjectOf HRESULT=0x${(hr3 >>> 0).toString(16)}`
    }
  }
  const ctxMenu = ctxMenuBuf.readBigUInt64LE(0)
  console.log(`[shell-ctx] ctxMenu=0x${ctxMenu.toString(16)}`)

  // 4. CreatePopupMenu + QueryContextMenu.
  const hmenu = CreatePopupMenu() as bigint
  if (hmenu === 0n) {
    callMethod(ctxMenu, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
    callMethod(parentFolder, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
    CoTaskMemFree(pidlAbs)
    return { ok: false, invoked: false, reason: 'CreatePopupMenu a retourné NULL' }
  }

  const hr4 = callMethod(
    ctxMenu,
    ICONTEXTMENU_QUERYCONTEXTMENU,
    {
      ret: 'long',
      // hMenu, indexMenu, idCmdFirst, idCmdLast, uFlags
      args: ['void *', 'uint32', 'uint32', 'uint32', 'uint32']
    },
    hmenu,
    0,
    ID_CMD_FIRST,
    ID_CMD_LAST,
    CMF_NORMAL | CMF_EXTENDEDVERBS
  ) as number
  console.log(`[shell-ctx] QueryContextMenu hr=0x${(hr4 >>> 0).toString(16)}`)
  if (hr4 < 0) {
    DestroyMenu(hmenu)
    callMethod(ctxMenu, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
    callMethod(parentFolder, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
    CoTaskMemFree(pidlAbs)
    return {
      ok: false,
      invoked: false,
      reason: `QueryContextMenu HRESULT=0x${(hr4 >>> 0).toString(16)}`
    }
  }

  // 5. Active la fenêtre parent et affiche le menu.
  // SetForegroundWindow + le hack PostMessage WM_NULL post-track sont des
  // recommandations Microsoft pour éviter que le menu reste à l'écran si
  // l'utilisateur clique en dehors (focus issues).
  SetForegroundWindow(parentHwnd)

  console.log('[shell-ctx] TrackPopupMenuEx (bloque jusqu\'au choix utilisateur)…')
  const cmd = TrackPopupMenuEx(
    hmenu,
    TPM_LEFTALIGN | TPM_RETURNCMD | TPM_RIGHTBUTTON,
    Math.round(req.screenX),
    Math.round(req.screenY),
    parentHwnd,
    null
  ) as number
  console.log(`[shell-ctx] TrackPopupMenuEx → cmd=${cmd}`)

  PostMessageW(parentHwnd, WM_NULL, 0n, 0n)

  let invoked = false
  let invokeError: string | null = null

  if (cmd > 0) {
    // 6. InvokeCommand.
    // Le struct CMINVOKECOMMANDINFO doit être une struct C alignée :
    //   DWORD cbSize        4 octets
    //   DWORD fMask         4 octets
    //   HWND hwnd           8 octets (x64)
    //   LPCSTR lpVerb       8 octets — pour ID, on met (char*)(idx + 0n)
    //   LPCSTR lpParameters 8 octets — null
    //   LPCSTR lpDirectory  8 octets — null
    //   int nShow           4 octets
    //   DWORD dwHotKey      4 octets — 0
    //   HANDLE hIcon        8 octets — null
    // Total = 56 octets (avec padding).
    //
    // Note ABI : sur x64, cbSize=4 puis fMask=4 = 8 (aligné), puis hwnd
    // commence à 8. Le compilateur C insère du padding entre dwHotKey
    // (offset 48) et hIcon (offset 56) pour aligner hIcon sur 8.
    const cbSize = 56
    const cmi = Buffer.alloc(cbSize)
    cmi.writeUInt32LE(cbSize, 0) // cbSize
    cmi.writeUInt32LE(0, 4) // fMask
    cmi.writeBigUInt64LE(parentHwnd, 8) // hwnd
    // lpVerb = (LPCSTR)MAKEINTRESOURCE(idCmd - idCmdFirst).
    // MAKEINTRESOURCE prend l'ID en bas-bits d'un pointeur. On écrit
    // l'entier comme pointeur 64-bit.
    cmi.writeBigUInt64LE(BigInt(cmd - ID_CMD_FIRST), 16)
    cmi.writeBigUInt64LE(0n, 24) // lpParameters
    cmi.writeBigUInt64LE(0n, 32) // lpDirectory
    cmi.writeInt32LE(SW_SHOWNORMAL, 40) // nShow
    cmi.writeUInt32LE(0, 44) // dwHotKey
    // padding [48..56) puis on écrirait hIcon, mais comme cbSize=56 et
    // hIcon est le dernier champ, l'écrire à 48 (hIcon = 0).
    cmi.writeBigUInt64LE(0n, 48) // hIcon

    const hr5 = callMethod(
      ctxMenu,
      ICONTEXTMENU_INVOKECOMMAND,
      { ret: 'long', args: ['void *'] },
      cmi
    ) as number
    console.log(`[shell-ctx] InvokeCommand hr=0x${(hr5 >>> 0).toString(16)}`)
    if (hr5 < 0) {
      invokeError = `InvokeCommand HRESULT=0x${(hr5 >>> 0).toString(16)}`
    } else {
      invoked = true
    }
  }

  // 7. Cleanup — ordre inverse de l'allocation.
  DestroyMenu(hmenu)
  callMethod(ctxMenu, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
  callMethod(parentFolder, IUNKNOWN_RELEASE, { ret: 'uint32', args: [] })
  CoTaskMemFree(pidlAbs)

  if (invokeError) {
    return { ok: false, invoked: false, reason: invokeError }
  }
  return { ok: true, invoked }
}

// CoUninitialize n'est appelé NULLE PART intentionnellement : Windows
// gère la désallocation à la fermeture du process Electron, et appeler
// CoUninitialize quand d'autres parties d'Electron pourraient utiliser
// COM (drag-drop, dialogs natifs) provoquerait un crash.
void CoUninitialize
