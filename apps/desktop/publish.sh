#!/bin/zsh
# Publishes the build in apps/desktop/release/ as the GitHub release v<version> on dhruvalgolakiya/tot, which is
# where the installed apps look for updates (updates.ts): npm run app:publish, after npm run app:release and
# after trying that build. Uploads the .dmg (first installs), the .zip and its .blockmap (updates), and
# latest-mac.yml (what tells the apps there's a new version).
#   --list               only check the files and print them; uploads nothing (release.sh ends with this)
#   --notes-file <file>  the release notes; otherwise a line on how to install
#   --draft              a draft release, which the apps don't see until it's published on GitHub
# Uses the dhruvalgolakiya account's gh login (gh auth login once), never a token in the repo or the app.
set -euo pipefail

repo=dhruvalgolakiya/tot
list_only=0
draft=()
notes_file=""
while (( $# )); do
  case $1 in
    --list) list_only=1 ;;
    --draft) draft=(--draft) ;;
    --notes-file) notes_file=${2:?--notes-file needs a file}; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
# A notes file is named from where the command ran (the repository root, for npm run app:publish).
[[ -n $notes_file ]] && notes_file=${notes_file:A}
cd "${0:A:h}"

fail() { echo "app:publish: $1" >&2; exit 1; }

version=$(node -p 'require("./package.json").version')
tag=v$version
dmg=release/TOT-$version-arm64.dmg
zip=release/TOT-$version-arm64-mac.zip
yml=release/latest-mac.yml
files=($dmg $zip $zip.blockmap $yml)
for f in $files; do
  [[ -f $f ]] || fail "$f is missing. Build it first: npm run app:release."
done

# latest-mac.yml names the zip the apps download; GitHub must serve it under exactly that name (it would turn a
# space into a dot), and it must still be the file the build hashed.
field() { sed -n "s/^$1: *//p" $yml | tr -d "'\""; }
[[ $(field version) == $version ]] || fail "$yml is for version $(field version), not $version. Run npm run app:release again."
[[ $(field path) == ${zip:t} ]] || fail "$yml points the apps at $(field path), not ${zip:t}."
for url in ${(f)"$(sed -n 's/^ *- url: *//p' $yml | tr -d "'\"")"}; do
  [[ $url =~ '^[A-Za-z0-9._-]+$' ]] || fail "$yml names $url, which GitHub would rename."
  (( ${files[(Ie)release/$url]} )) || fail "$yml names $url, which isn't among the files to upload."
done
[[ $(openssl dgst -sha512 -binary $zip | base64) == $(field sha512) ]] || fail "${zip:t} changed after the build wrote $yml. Run npm run app:release again."

# Squirrel.Mac only installs an update signed like the app it replaces, so never publish an ad hoc build.
signature=$(codesign -dv --verbose=2 release/mac-arm64/TOT.app 2>&1 || true)
[[ $signature == *$'\nAuthority=Developer ID Application'* ]] ||
  fail "release/mac-arm64/TOT.app isn't signed with the Developer ID. Build with npm run app:release, not app:build."
xcrun stapler validate -q $dmg || fail "${dmg:t} isn't notarized and stapled. Build with npm run app:release."

if (( list_only )); then
  echo "\nTo publish TOT $version (npm run app:publish uploads these as the GitHub release $tag):"
  for f in $files; do echo "  $f"; done
  exit 0
fi

[[ -z $(git status --porcelain --untracked-files=no) ]] || fail "there are uncommitted changes: commit the code this build came from first."
[[ -n $(git branch -r --contains HEAD) ]] || fail "HEAD ($(git rev-parse --short HEAD)) isn't on GitHub yet: push it first, so $tag points at the code that was built."

token=$(gh auth token --user dhruvalgolakiya) || fail "gh isn't logged in as dhruvalgolakiya: gh auth login, then try again."
export GH_TOKEN=$token
if gh release view $tag -R $repo >/dev/null 2>&1; then fail "$repo already has a release $tag. Bump the version in apps/desktop/package.json and apps/server/config.ts."; fi

notes=()
if [[ -n $notes_file ]]; then
  notes=(--notes-file $notes_file)
else
  notes=(--notes "Signed and notarized for Apple silicon Macs. Download **${dmg:t}**, open it and drag TOT to Applications. TOT already installed updates itself.")
fi
gh release create $tag $files -R $repo --target $(git rev-parse HEAD) --title "TOT $version (Mac)" $notes $draft
echo "Published $tag on $repo."
