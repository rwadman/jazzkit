#!/usr/bin/env python3
"""
Symbolicate the newest MuseScore crash minidump (macOS, Apple Silicon).

MuseScore 4 uses Crashpad, which writes .dmp minidumps to
    ~/Library/Application Support/MuseScore/MuseScore4/logs/dumps/completed/
When a plugin crashes MuseScore there is NO usable stack trace in the log -
this reconstructs one by scanning the crashed process's stack memory for
return addresses that fall inside the mscore binary and running each through
`atos` against the installed MuseScore.app.

Usage:
    python3 analyze-crash.py [path-to.dmp]      # default: newest completed dump

Deps:  pip3 install minidump aenum
Only works on the machine that produced the dump (same MuseScore build), since
atos symbolicates against /Applications/MuseScore 4.app.
"""
import glob
import os
import struct
import subprocess
import sys

MSCORE = "/Applications/MuseScore 4.app/Contents/MacOS/mscore"
DUMP_DIR = os.path.expanduser(
    "~/Library/Application Support/MuseScore/MuseScore4/logs/dumps/completed"
)


def newest_dump():
    dumps = glob.glob(os.path.join(DUMP_DIR, "*.dmp"))
    if not dumps:
        sys.exit(f"No dumps found in {DUMP_DIR}")
    return max(dumps, key=os.path.getmtime)


def load_minidump(path):
    # The `minidump` lib predates Apple Silicon: PROCESSOR_ARCHITECTURE has no
    # ARM64 (=12) member, so parsing throws. Register it before importing.
    import minidump.streams.SystemInfoStream as sysmod
    from aenum import extend_enum

    if not any(m.value == 12 for m in sysmod.PROCESSOR_ARCHITECTURE):
        extend_enum(sysmod.PROCESSOR_ARCHITECTURE, "ARM64", 12)

    import logging
    logging.disable(logging.CRITICAL)  # silence the PEB-parse warning for ARM64

    from minidump.minidumpfile import MinidumpFile
    return MinidumpFile.parse(path)


def mscore_range(mf):
    for m in mf.modules.modules:
        if "MacOS/mscore" in (m.name or ""):
            return m.baseaddress, m.baseaddress + m.size
    sys.exit("mscore module not found in dump")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else newest_dump()
    print(f"Dump: {path}\n")
    mf = load_minidump(path)

    base, end = mscore_range(mf)
    print(f"mscore loaded at {hex(base)} - {hex(end)}")

    # Crash reason
    try:
        rec = mf.exception.exception_records[0].ExceptionRecord
        print(f"Exception: {rec.ExceptionCode} at {hex(rec.ExceptionAddress)}")
    except Exception:
        pass
    print()

    # Scan every captured memory region (stacks) for 8-byte-aligned values that
    # land inside the mscore text range. These are return addresses = the call
    # stack. Preserve order; dedupe consecutive repeats.
    fname = mf.filename if hasattr(mf, "filename") else path
    addrs = []
    with open(fname, "rb") as f:
        for seg in mf.memory_segments.memory_segments:
            f.seek(seg.start_file_address)
            data = f.read(seg.size)
            for i in range(0, len(data) - 8, 8):
                (val,) = struct.unpack_from("<Q", data, i)
                if base <= val < end:
                    if not addrs or addrs[-1] != val:
                        addrs.append(val)

    if not addrs:
        sys.exit("No mscore return addresses found on the stack.")

    # Symbolicate in one atos call.
    out = subprocess.run(
        ["atos", "-arch", "arm64", "-o", MSCORE, "-l", hex(base)]
        + [hex(a) for a in addrs],
        capture_output=True, text=True,
    ).stdout.splitlines()

    print("Stack candidates (most relevant frames are the non-generic C++ names):\n")
    seen = set()
    for a, sym in zip(addrs, out):
        # Skip std:: / boilerplate noise unless unique enough to matter.
        line = f"  {hex(a)}  {sym}"
        if sym not in seen:
            print(line)
            seen.add(sym)


if __name__ == "__main__":
    main()
