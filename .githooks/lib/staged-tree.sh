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

# Prints, NUL-separated, the tracked files whose work tree content isn't what's staged (with the copied index).
unstaged_files() {
    GIT_INDEX_FILE="$run/index" git update-index -q --refresh >/dev/null || true
    GIT_INDEX_FILE="$run/index" git diff-files --name-only -z
}
