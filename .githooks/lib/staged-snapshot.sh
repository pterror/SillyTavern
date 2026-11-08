# Sourced by the hooks in .githooks.
#
# Sourcing sets `toplevel` (the work tree root, and cds there) and `cache`, this clone's directory outside the
# repository, and takes the lock on it. `staged_tree` names the tree the commit will record: the index git hands the
# hook, which is GIT_INDEX_FILE's for `commit -a`, `commit <paths>` and caller-supplied temp indexes.
# `update_snapshot <tree>` makes `snap_tree` hold exactly that tree. Unstaged edits and untracked files in the work
# tree are never seen, and the work tree and the real index are never written.

# A relative GIT_INDEX_FILE is relative to the top of the work tree.
toplevel="$(git rev-parse --show-toplevel)"
cd "$toplevel"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/st-precommit/$(git rev-parse --path-format=absolute --git-common-dir | sha256sum | head -c 16)"
mkdir -p "$cache"
exec 9>"$cache/lock"
flock 9

run="$(mktemp -d "$cache/run.XXXXXXXX")"
trap 'rm -rf "$run"' EXIT

snap_index="$cache/index"
snap_tree="$cache/tree"

# Writes the tree from a copy of the index, so the real one's cached tree isn't rewritten. write-tree drops
# intent-to-add (`git add -N`) entries, which aren't committed.
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

# The clean removes whatever a tool left in the snapshot, so no check sees a file that isn't in the tree.
update_snapshot() {
    mkdir -p "$snap_tree"
    GIT_INDEX_FILE="$snap_index" GIT_WORK_TREE="$snap_tree" git read-tree --reset -u --no-sparse-checkout "$1"
    GIT_INDEX_FILE="$snap_index" GIT_WORK_TREE="$snap_tree" git clean -ffdxq -e /node_modules
}

# A workspace package (a link to a directory of the repository, like @st/ui -> packages/ui) is linked to its directory
# in the snapshot, so importing it by name sees the staged version.
link_modules() {
    local modules="$toplevel/node_modules" target entry name child
    local -A workspace=() scopes=()
    rm -rf "$snap_tree/node_modules"
    mkdir "$snap_tree/node_modules"
    while IFS= read -r -d '' entry; do
        target="$(realpath -- "$entry")"
        case "$target" in
            "$modules"/*) ;;
            "$toplevel"/*)
                name="${entry#"$modules"/}"
                workspace["$name"]="${target#"$toplevel"/}"
                [[ "$name" == */* ]] && scopes["${name%%/*}"]=1
                ;;
        esac
    done < <(find "$modules" -mindepth 1 -maxdepth 2 -type l -not -path "$modules/.bin/*" -print0)
    shopt -s nullglob dotglob
    for entry in "$modules"/*; do
        name="${entry##*/}"
        case "$name" in .vite | .vite-temp | .cache) continue ;; esac
        if [ -n "${scopes[$name]+set}" ]; then
            mkdir "$snap_tree/node_modules/$name"
            for child in "$entry"/*; do
                link_module "$child" "$name/${child##*/}"
            done
        else
            link_module "$entry" "$name"
        fi
    done
    shopt -u nullglob dotglob
}

link_module() {
    if [ -n "${workspace[$2]+set}" ]; then
        ln -s "$snap_tree/${workspace[$2]}" "$snap_tree/node_modules/$2"
    else
        ln -s "$1" "$snap_tree/node_modules/$2"
    fi
}
