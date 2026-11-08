# Sourced by the hooks in .githooks.
#
# Sourcing sets `toplevel` (the work tree root, and cds there) and `cache`, this clone's directory outside the
# repository, takes the lock on it, and makes `run`, a directory removed on exit. `staged_tree` writes and names the
# tree the commit will record: the index git hands the hook, which is GIT_INDEX_FILE's for `commit -a`,
# `commit <paths>` and caller-supplied temp indexes, copied to $run/index so the real one isn't rewritten.
# write-tree drops intent-to-add (`git add -N`) entries, which aren't committed.

# A relative GIT_INDEX_FILE is relative to the top of the work tree.
toplevel="$(git rev-parse --show-toplevel)"
cd "$toplevel"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/st-precommit/$(git rev-parse --path-format=absolute --git-common-dir | sha256sum | head -c 16)"
mkdir -p "$cache"
exec 9>"$cache/lock"
flock 9

run="$(mktemp -d "$cache/run.XXXXXXXX")"
trap 'rm -rf "$run"' EXIT

staged_tree() {
    local index_file
    index_file="$(git rev-parse --git-path index)"
    case "$index_file" in
        /*) ;;
        *) index_file="$toplevel/$index_file" ;;
    esac
    if [ -e "$index_file" ]; then
        cp "$index_file" "$run/index"
    fi
    GIT_INDEX_FILE="$run/index" git write-tree
}

# For the tools that read only the disk: `prepare_view <tree>` lists how the work tree differs from <tree>, and
# `in_view <command>...` runs the command with the top of the work tree showing <tree>. That is an overlay mount over
# the work tree, in a user and mount namespace of the command's own, whose upper layer (a tmpfs) holds the staged
# version of each tracked file the work tree has otherwise and hides each file and directory git doesn't track
# (node_modules excepted). Nothing outside the namespace sees it, and it goes when the command exits.
prepare_view() {
    local record file
    local -A differing=()
    GIT_INDEX_FILE="$run/index" git update-index -q --refresh >/dev/null || true
    while IFS= read -r -d '' file; do
        differing["$file"]=1
    done < <(GIT_INDEX_FILE="$run/index" git diff-files --name-only -z)
    : > "$run/view-swap"
    if [ "${#differing[@]}" -gt 0 ]; then
        while IFS= read -r -d '' record; do
            file="${record#*$'\t'}"
            [ -n "${differing[$file]+set}" ] || continue
            read -r mode _ blob <<< "${record%%$'\t'*}"
            printf '%s\0%s\0%s\0' "$mode" "$blob" "$file" >> "$run/view-swap"
        done < <(git ls-tree -r -z --full-tree "$1")
    fi
    {
        GIT_INDEX_FILE="$run/index" git diff-index --cached --name-only -z "$1"
        GIT_INDEX_FILE="$run/index" git ls-files --others --directory --no-empty-directory -z
        GIT_INDEX_FILE="$run/index" git ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z
    } | while IFS= read -r -d '' file; do
        file="${file%/}"
        [[ "/$file/" == */node_modules/* ]] || printf '%s\0' "$file"
    done | sort -zu > "$run/view-hide"
}

in_view() {
    unshare --user --map-root-user --mount -- bash -c '
        set -euo pipefail
        toplevel="$1" run="$2"
        shift 2
        layer="$(mktemp -d "$run/view.XXXXXXXX")"
        mount -t tmpfs tmpfs "$layer"
        mkdir "$layer/upper" "$layer/work"
        while IFS= read -r -d "" mode && IFS= read -r -d "" blob && IFS= read -r -d "" file; do
            mkdir -p "$layer/upper/$(dirname -- "$file")"
            git -C "$toplevel" cat-file blob "$blob" > "$layer/upper/$file"
            if [ "$mode" = 100755 ]; then chmod +x "$layer/upper/$file"; fi
        done < "$run/view-swap"
        while IFS= read -r -d "" file; do
            mkdir -p "$layer/upper/$(dirname -- "$file")"
            mknod "$layer/upper/$file" c 0 0
        done < "$run/view-hide"
        mount -t overlay overlay -o "lowerdir=$toplevel,upperdir=$layer/upper,workdir=$layer/work,userxattr" "$toplevel"
        cd "$toplevel"
        exec "$@"
    ' in-view "$toplevel" "$run" "$@"
}
