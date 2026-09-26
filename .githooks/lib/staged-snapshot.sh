# Sourced by the hooks in .githooks.
#
# Sourcing sets `toplevel` (the work tree root) and cds there. `build_staged_snapshot` then checks out
# the tree the commit will record into `snap_tree`, a temp dir removed on exit. That tree is the index
# git hands the hook, which is GIT_INDEX_FILE's for `commit -a`, `commit <paths>` and caller-supplied
# temp indexes. Unstaged edits and untracked files in the work tree are never seen, and the work tree
# and the real index are never written.

# A relative GIT_INDEX_FILE is relative to the top of the work tree.
toplevel="$(git rev-parse --show-toplevel)"
cd "$toplevel"

build_staged_snapshot() {
    local index_file snap_index staged_tree
    index_file="$(git rev-parse --git-path index)"
    case "$index_file" in
        /*) ;;
        *) index_file="$toplevel/$index_file" ;;
    esac

    # Work on a copy of the index so nothing here can touch the real one. write-tree + read-tree
    # drops intent-to-add (`git add -N`) entries, which aren't committed but which checkout-index
    # would write out as empty files. node_modules is symlinked in so the tools resolve packages as
    # they do in the checkout.
    snapshot="$(mktemp -d "${TMPDIR:-/tmp}/st-precommit.XXXXXXXX")"
    trap 'rm -rf "$snapshot"' EXIT

    snap_index="$snapshot/.git-index"
    snap_tree="$snapshot/tree"
    mkdir "$snap_tree"
    if [ -e "$index_file" ]; then
        cp "$index_file" "$snap_index"
    fi
    staged_tree="$(GIT_INDEX_FILE="$snap_index" git write-tree)"
    GIT_INDEX_FILE="$snap_index" git read-tree "$staged_tree"
    GIT_INDEX_FILE="$snap_index" git checkout-index -a -f --ignore-skip-worktree-bits --prefix="$snap_tree/"
    ln -s "$toplevel/node_modules" "$snap_tree/node_modules"
}
