# Icône de l'application (`icon.ico`)

Placer ici un fichier `icon.ico` multi-résolutions (16, 32, 48, 64, 128, 256 px) pour l'installeur NSIS Windows et l'exécutable.

## Génération rapide

À partir d'un SVG ou PNG 512×512 source :

```bash
# Via ImageMagick (installé localement) :
magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

Ou en ligne : https://convertio.co/fr/png-ico/

L'icône est référencée depuis `electron-builder.yml` → `win.icon: build/icon.ico`.
