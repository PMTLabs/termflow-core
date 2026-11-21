# Static POSIX collector. $1 is the encoder's hex nonce, not remote user data.
LC_ALL=C LANG=C TZ=UTC DF_BLOCK_SIZE=1024 BLOCK_SIZE=1024 BLOCKSIZE=1024
export LC_ALL LANG TZ DF_BLOCK_SIZE BLOCK_SIZE BLOCKSIZE

prefix=__TFM_${1}_
section_begin() { printf '%sSECTION_%s_BEGIN__\n' "$prefix" "$1"; }
section_end() { printf '\n%sSECTION_%s_END_%s__\n' "$prefix" "$1" "$2"; }
section() {
    section_key=$1
    shift
    section_begin "$section_key"
    "$@"
    section_end "$section_key" "$?"
}

printf '%sV1_BEGIN__\n' "$prefix"
platform=$(uname -s)
status=$?
section_begin platform
printf '%s' "$platform"
section_end platform "$status"
section hostname uname -n
section architecture uname -m
if [ "$status" -eq 0 ] && [ "$platform" = Linux ]; then
    section stat cat /proc/stat
    section meminfo cat /proc/meminfo
    section netdev cat /proc/net/dev
    section uptime cat /proc/uptime
    section bootId cat /proc/sys/kernel/random/boot_id
    section cpuinfo cat /proc/cpuinfo
    section nproc nproc
    section loadavg cat /proc/loadavg
    section who who
    section osRelease cat /etc/os-release

    # Keep the inventory and the presence check tied to the same proc read.
    inventory=$(cat /proc/mounts)
    inventory_status=$?
    section_begin mounts
    printf '%s' "$inventory"
    section_end mounts "$inventory_status"
    has_nfs=no
    while IFS=' ' read -r source mount type rest; do
        case "$type" in nfs|nfs4) has_nfs=yes ;; esac
    done <<EOF
$inventory
EOF

    # A failed attempt can print partial rows. Never emit them as fallback data.
    local_df=$(df -l -P -T)
    local_status=$?
    if [ "$local_status" -ne 0 ]; then
        local_df=$(df -l -P)
        local_status=$?
    fi
    section_begin dfLocal
    printf '%s' "$local_df"
    section_end dfLocal "$local_status"

    section_begin dfNfs
    if [ "$inventory_status" -ne 0 ]; then
        section_end dfNfs 125
    elif [ "$has_nfs" = no ]; then
        section_end dfNfs 0
    elif ! command -v timeout >/dev/null 2>&1; then
        section_end dfNfs 127
    else
        timeout -s KILL 2 df -P -t nfs -t nfs4
        section_end dfNfs "$?"
    fi
fi
printf '%sV1_END__\n' "$prefix"
