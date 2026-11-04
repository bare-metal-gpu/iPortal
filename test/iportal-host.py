import importlib.util
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'ios/link-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
LIBRARY = '@executable_path/Frameworks/iPortalUI.framework/iPortalUI'


def executable(padding=256):
    # One __TEXT section; its contents must survive the added dependency.
    data = bytearray(32 + 152 + padding + 64)
    struct.pack_into('<8I', data, 0, 0xFEEDFACF, 0x100000C, 0, 2, 1, 152, 0, 0)
    struct.pack_into('<II', data, 32, 0x19, 152)
    struct.pack_into('<I', data, 32 + 64, 1)
    struct.pack_into('<I', data, 32 + 72 + 48, 32 + 152 + padding)
    data[-64:] = bytes(range(64))
    return bytes(data)


class HostTests(unittest.TestCase):
    def test_preserves_sections_and_is_idempotent(self):
        before = executable()
        after = host.link(before, LIBRARY)
        self.assertEqual(len(before), len(after))
        self.assertEqual(before[-64:], after[-64:])
        self.assertEqual(struct.unpack_from('<I', after, 16)[0], 2)
        self.assertEqual(host.link(after, LIBRARY), after)

    def test_single_slice_universal_preserves_container(self):
        thin = executable()
        header = struct.pack('>7I', 0xCAFEBABE, 1, 0x100000C, 0, 4096, len(thin), 12)
        fat = header.ljust(4096, b'\0') + thin
        after = host.link(fat, LIBRARY)
        self.assertEqual(after[:4096], fat[:4096])
        self.assertEqual(after[4096:], host.link(thin, LIBRARY))
        self.assertEqual(host.link(after, LIBRARY), after)

    def test_rejects_unsafe_layouts(self):
        occupied = bytearray(executable()); occupied[184] = 1
        invalid_count = bytearray(executable()); struct.pack_into('<I', invalid_count, 16, 2)
        for data in [b'not mach-o', executable(0), occupied, invalid_count]:
            with self.assertRaises(ValueError): host.link(data, LIBRARY)


if __name__ == '__main__': unittest.main()
