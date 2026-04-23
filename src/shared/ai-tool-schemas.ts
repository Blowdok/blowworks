// Schémas function-calling OpenAI pour les 8 tools wiki de BlowWorks.
// Adapté du pattern nexusvault_v4 avec un scope réduit au wiki/mémoire
// (pas de run_command, pas d'accès fichier hors du dossier wiki).
//
// Classification :
//   read_* / list_* / search_*  → auto-approuvés, retournent tronqué
//   write_* / rename_* / delete_* → confirmation utilisateur requise
//
// Les descriptions sont explicites pour guider le modèle : si une
// description est vague, le modèle invente ou n'appelle jamais le tool.

export const WIKI_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_wiki_page',
      description:
        "Lit le contenu complet d'une page wiki existante. Retourne le markdown tel quel (frontmatter YAML inclus). Utilise ce tool avant de répondre à une question qui nécessite le contenu détaillé d'un concept, ou avant de modifier une page existante.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              "Chemin relatif au dossier wiki/, ex. 'concepts/pagemark.md' ou 'connections/pagemark-stack.md'. PAS de prefix 'wiki/' (le runner l'ajoute)."
          }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_wiki_pages',
      description:
        "Liste toutes les pages wiki avec leur chemin relatif et leur taille. Utile pour choisir laquelle lire ou pour vérifier l'existence d'une page avant d'en créer une nouvelle.",
      parameters: {
        type: 'object',
        properties: {
          subdir: {
            type: 'string',
            description:
              "Optionnel. Filtre par sous-dossier (ex. 'concepts', 'connections', 'qa'). Omet pour lister toutes les pages."
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_wiki',
      description:
        "Recherche une regex dans le contenu de toutes les pages wiki. Retourne jusqu'à 50 correspondances au format 'chemin:ligne:extrait'. Utilise-la pour retrouver un concept par mot-clé quand tu ne connais pas le nom exact de la page.",
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Motif regex (syntaxe JavaScript).'
          },
          flags: {
            type: 'string',
            description: "Flags regex (défaut 'gi')."
          }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_wiki_schema',
      description:
        "Lit le SCHEMA.md du wiki (conventions YAML, analogie compiler, workflows). À consulter si tu dois créer une nouvelle page et respecter le format.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_wiki_index',
      description:
        "Lit le wiki/index.md — catalogue plat avec titre + résumé 1-ligne de chaque page. Source de vérité pour savoir ce qui est compilé dans le wiki.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_wiki_page',
      description:
        "⚠️ DESTRUCTIF — nécessite confirmation. Crée ou écrase une page wiki. Utilise ce tool UNIQUEMENT pour classer (file-back) une réponse importante qui enrichit le wiki, pas pour du brouillon. Respecte le SCHEMA.md (frontmatter YAML complet + structure de sections).",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              "Chemin relatif au dossier wiki/, ex. 'qa/decision-pagemark-stack.md'. kebab-case.md."
          },
          content: {
            type: 'string',
            description:
              'Contenu markdown complet de la page (frontmatter YAML en tête + corps structuré).'
          }
        },
        required: ['name', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rename_wiki_page',
      description:
        '⚠️ DESTRUCTIF — nécessite confirmation. Renomme/déplace une page wiki. Les wikilinks pointant vers l\'ancien nom ne sont PAS mis à jour automatiquement — prévois ensuite des write_wiki_page pour corriger les liens entrants.',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: 'Ancien chemin relatif.'
          },
          to: {
            type: 'string',
            description: 'Nouveau chemin relatif.'
          }
        },
        required: ['from', 'to'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_wiki_page',
      description:
        '⚠️ DESTRUCTIF — nécessite confirmation. Supprime définitivement une page wiki. Les pages orphelines qui pointent vers elle ne sont pas nettoyées. À éviter sauf demande explicite de l\'utilisateur.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Chemin relatif au dossier wiki/.'
          }
        },
        required: ['name'],
        additionalProperties: false
      }
    }
  }
] as const

// Noms des tools qui exigent une confirmation utilisateur avant exécution.
// Toute action qui mute le FS passe par ici. Les tools read-only sont
// auto-approuvés pour que l'IA puisse naviguer le wiki sans friction.
export const TOOLS_REQUIRE_CONFIRMATION: ReadonlySet<string> = new Set([
  'write_wiki_page',
  'rename_wiki_page',
  'delete_wiki_page'
])

// Liste des noms pour validation côté runner.
export const TOOL_NAMES: ReadonlySet<string> = new Set(
  WIKI_TOOL_SCHEMAS.map((t) => t.function.name)
)

export type ToolName =
  | 'read_wiki_page'
  | 'list_wiki_pages'
  | 'search_wiki'
  | 'read_wiki_schema'
  | 'read_wiki_index'
  | 'write_wiki_page'
  | 'rename_wiki_page'
  | 'delete_wiki_page'

export interface ToolCall {
  id: string
  name: ToolName | string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  id: string
  result: string
  error?: string
}
