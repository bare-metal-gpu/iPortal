"""Add one signed, embedded UI dependency to the generated arm64 test host.

Only unused Mach-O header padding is changed. Refuse unfamiliar formats or
insufficient padding rather than moving sections or changing executable code.
"""
import struct
import sys
from pathlib import Path


def link(data, library):
    data = bytearray(data)
    if len(data) >= 28 and struct.unpack_from('>I', data)[0] == 0xCAFEBABE:
        count = struct.unpack_from('>I', data, 4)[0]
        cpu, _, offset, size, _ = struct.unpack_from('>5I', data, 8)
        if count != 1 or cpu != 0x100000C or offset < 28 or offset + size > len(data):
            raise ValueError('Expected a single arm64 slice in the universal host')
        data[offset:offset + size] = link(data[offset:offset + size], library)
        return bytes(data)
    if len(data) < 32 or struct.unpack_from('<I', data)[0] != 0xFEEDFACF:
        raise ValueError('Expected a thin 64-bit Mach-O host')
    _, cpu, _, kind, count, size, _, _ = struct.unpack_from('<8I', data)
    if cpu != 0x100000C or kind != 2:
        raise ValueError('Expected an arm64 executable host')
    end = 32 + size
    if end > len(data): raise ValueError('Invalid load-command size')
    offset, first_section = 32, len(data)
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        if length < 8 or length % 8 or offset + length > end:
            raise ValueError('Invalid load command')
        if command == 0xC:
            name_offset = struct.unpack_from('<I', data, offset + 8)[0]
            if bytes(data[offset + name_offset:offset + length]).split(b'\0')[0] == library.encode():
                return bytes(data)
        if command == 0x19:
            sections = struct.unpack_from('<I', data, offset + 64)[0]
            if 72 + sections * 80 > length: raise ValueError('Invalid segment')
            for index in range(sections):
                section = offset + 72 + index * 80
                file_offset = struct.unpack_from('<I', data, section + 48)[0]
                if file_offset: first_section = min(first_section, file_offset)
        offset += length
    if offset != end: raise ValueError('Load-command count mismatch')
    name = library.encode() + b'\0'
    length = (24 + len(name) + 7) & ~7
    if end + length > first_section or any(data[end:end + length]):
        raise ValueError('No unused header padding for Portal UI; unsupported Xcode host')
    command = struct.pack('<6I', 0xC, length, 24, 0, 0x10000, 0x10000) + name
    data[end:end + length] = command.ljust(length, b'\0')
    struct.pack_into('<II', data, 16, count + 1, size + length)
    return bytes(data)


if __name__ == '__main__':
    host = Path(sys.argv[1])
    host.write_bytes(link(host.read_bytes(), '@executable_path/Frameworks/PortalUI.framework/PortalUI'))
