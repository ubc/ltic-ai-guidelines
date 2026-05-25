# ltic ai policy — preview + verification tooling
# requires: just (brew install just), Google Chrome.app

set shell := ["bash", "-cu"]

chrome  := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
dir     := justfile_directory()
pdf_out := justfile_directory() + "/ltic-ai-guidelines.pdf"

# show available recipes
default:
    @just --list

# open ltic-ai-guidelines.html in the default browser
open:
    open "{{dir}}/ltic-ai-guidelines.html"

# regenerate ltic-ai-guidelines.png used by the README
preview:
    "{{chrome}}" \
      --headless=new --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=1.5 --window-size=900,1850 \
      --screenshot="{{dir}}/ltic-ai-guidelines.png" \
      "file://{{dir}}/ltic-ai-guidelines.html"
    @echo "ltic-ai-guidelines.png updated"

# render ltic-ai-guidelines.html to ltic-ai-guidelines.pdf in the repo
pdf:
    "{{chrome}}" \
      --headless=new --disable-gpu \
      --print-to-pdf="{{pdf_out}}" --print-to-pdf-no-header \
      "file://{{dir}}/ltic-ai-guidelines.html"
    @echo "PDF written to {{pdf_out}}"

# count pages in the rendered PDF (target: 2)
pages: pdf
    @uv run python3 -c "import re; d=open('{{pdf_out}}','rb').read(); print('pages:', len(re.findall(rb'/Type\\s*/Page[^s]', d)))"

# regenerate preview AND verify page count — run before commit
check: preview pages
