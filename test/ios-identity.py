import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('identity', Path(__file__).resolve().parents[1] / 'scripts/configure-ios.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class IdentityTests(unittest.TestCase):
    def test_fresh_upgrade_repeat_and_team_change(self):
        for old in ['com.facebook.WebDriverAgentRunner', 'com.testteam01.iphonemirror.WebDriverAgentRunner']:
            source = (f'PRODUCT_BUNDLE_IDENTIFIER = {old};\nPRODUCT_NAME = "$(TARGET_NAME)";\n' * 3
                      + 'PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentLib;\nPRODUCT_NAME = "$(TARGET_NAME)";')
            changed = identity.configure(source, 'TESTTEAM01')
            self.assertEqual(changed.count('com.testteam01.iportal.mobile'), 3)
            self.assertEqual(changed.count('PRODUCT_NAME = iPortalRunner;'), 3)
            self.assertIn('com.facebook.WebDriverAgentLib', changed)
            self.assertEqual(identity.configure(changed, 'TESTTEAM01'), changed)
            self.assertEqual(identity.configure(changed, 'ABCDEFGHIJ').count('com.abcdefghij.iportal.mobile'), 3)

    def test_invalid_input_fails_before_writing(self):
        with self.assertRaises(ValueError):
            identity.configure('', 'TESTTEAM01')
        with self.assertRaises(ValueError):
            identity.configure('', '../invalid')


if __name__ == '__main__':
    unittest.main()
