This session's shell is zsh with a customized `$IFS` (starship/atuin set
non-default IFS chars). `for p in $SOME_VAR` where `$SOME_VAR` holds a
space-separated list does NOT word-split in zsh the way it would in
bash/sh — zsh only splits unquoted params on `$IFS` when `SH_WORD_SPLIT` is
set, which it isn't here. Result: the whole variable is treated as ONE
loop item, silently, no error — a `[ -d "$SRC/$p" ]` check then reports
every package as "missing" even though the paths are correct.

**Why:** burned several tool calls diagnosing "file not found" for
packages that were actually present, before isolating it to word-splitting
and not path/permission issues.

**How to apply:** never loop over a space-separated string variable in a
Bash-tool command. Either list the items literally in the `for p in a b c`
line, or use `${=SOME_VAR}` / an array (`arr=(a b c); for p in "${arr[@]}"`).
Same applies to any other space-joined-string-in-a-var pattern.
