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

local_df_by_type() {
    # BusyBox 1.36 df filters by type before statvfs. Keep this list in
    # sync with protocol.rs; the parser decides which overlay rows to keep.
    local_types='ext2 ext3 ext4 xfs btrfs zfs overlay f2fs jfs reiserfs vfat exfat ntfs ntfs3 bcachefs udf fuseblk'
    # A local record can be hidden by a different filesystem at the same
    # path. Fail closed rather than let df stat the visible foreign mount.
    types=$(awk -v local_types="$local_types" '
        BEGIN { n = split(local_types, types, " ") }
        NF != 6 || $2 !~ /^\// { invalid = 1; next }
        {
            if ($2 in mounted && mounted[$2] != $3) stacked[$2] = 1
            mounted[$2] = $3
            present[$3] = 1
            if (index(" " local_types " ", " " $3 " ")) local_path[$2] = 1
        }
        END {
            for (point in stacked) if (point in local_path) invalid = 1
            if (invalid) exit 1
            for (i = 1; i <= n; i++) if (types[i] in present) print types[i]
        }
    ' <<EOF
$inventory
EOF
    ) || return "$?"
    unset POSIXLY_CORRECT
    header=
    for fs_type in $types; do
        output=$(df -P -T -t "$fs_type") || return "$?"
        current_header=${output%%"$newline"*}
        case "$current_header" in Filesystem*) ;; *) return 1 ;; esac
        if [ -z "$header" ]; then
            header=$current_header
            printf '%s\n' "$header"
        elif [ "$header" != "$current_header" ]; then
            return 1
        fi
        case "$output" in *"$newline"*) printf '%s\n' "${output#*"$newline"}" ;; esac
    done
    if [ -z "$header" ]; then
        printf 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n'
    fi
}

newline='
'
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
    who_rows=$(who)
    who_status=$?
    if [ "$who_status" -eq 0 ] && [ -z "$who_rows" ] &&
       ! test -e /var/run/utmp && ! test -e /run/utmp; then
        who_status=123
    fi
    section_begin who
    printf '%s' "$who_rows"
    section_end who "$who_status"
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
    if [ "$local_status" -ne 0 ] && [ "$inventory_status" -eq 0 ]; then
        local_df=$(local_df_by_type)
        local_status=$?
    fi
    section_begin dfLocal
    if [ "$local_status" -eq 0 ]; then printf '%s' "$local_df"; fi
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
elif [ "$status" -eq 0 ] && [ "$platform" = Darwin ]; then
    section swVers /usr/bin/sw_vers
    section ncpu /usr/sbin/sysctl -n hw.logicalcpu
    section memsize /usr/sbin/sysctl -n hw.memsize
    section pagesize /usr/sbin/sysctl -n hw.pagesize
    section boottime /usr/sbin/sysctl -n kern.boottime
    section now /bin/date -u +%s
    section loadavg /usr/sbin/sysctl -n vm.loadavg
    section vmstat /usr/bin/vm_stat
    section netstat /usr/sbin/netstat -ibn
    section iostat /usr/sbin/iostat -c 2 -w 1
    section who /usr/bin/who
    section mounts /sbin/mount
    section dfLocal /bin/df -P -l -k
    section_begin dfNfs
    # Never stat a network filesystem without a fixed, absolute watchdog.
    if [ -x /usr/local/bin/timeout ]; then
        /usr/local/bin/timeout -s KILL 2 /bin/df -P -k -t nfs
        section_end dfNfs "$?"
    elif [ -x /opt/homebrew/bin/gtimeout ]; then
        /opt/homebrew/bin/gtimeout -s KILL 2 /bin/df -P -k -t nfs
        section_end dfNfs "$?"
    else
        section_end dfNfs 127
    fi

fi
printf '%sV1_END__\n' "$prefix"
