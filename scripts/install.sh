#!/bin/sh
set -eu

for command in git node npm; do
  command -v "$command" >/dev/null 2>&1 || { echo "Install $command first." >&2; exit 1; }
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 2)) { console.error("Node 24.2 or newer is required."); process.exit(1); }'

install_dir="$HOME/.local/share/sage"
bin_dir="$HOME/.local/bin"
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  echo "Sage already exists at $install_dir. Run sage update, or move it aside first." >&2
  exit 1
fi
if [ -e "$bin_dir/sage" ] || [ -L "$bin_dir/sage" ]; then
  echo "A sage command already exists at $bin_dir/sage. Move it aside first." >&2
  exit 1
fi
mkdir -p "$(dirname "$install_dir")" "$bin_dir"
git clone --branch main --single-branch https://github.com/BrandonLee28/sage-pi.git "$install_dir"
npm ci --omit=dev --prefix "$install_dir"
ln -s "$install_dir/bin/sage.mjs" "$bin_dir/sage"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    path_line='export PATH="$HOME/.local/bin:$PATH"'
    touch "$HOME/.zshrc"
    grep -Fqx "$path_line" "$HOME/.zshrc" || printf '\n%s\n' "$path_line" >> "$HOME/.zshrc"
    echo 'Open a new terminal or run: export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac
echo 'Installed Sage. Run sage to connect, or sage update to update.'
