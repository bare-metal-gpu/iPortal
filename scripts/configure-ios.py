#!/usr/bin/env python3
"""Set our runner identity without renaming upstream library/test targets."""
from pathlib import Path
import re
import sys


def configure(source, team):
    if not re.fullmatch(r'[A-Z0-9]{10}', team):
        raise ValueError('Expected a ten-character Apple development team ID')
    bundle = f'com.{team.lower()}.iportal.mobile'
    count = 0

    def replace(match):
        nonlocal count
        if not match[1].endswith(('.WebDriverAgentRunner', '.iportal.mobile')):
            return match[0]
        count += 1
        return f'PRODUCT_BUNDLE_IDENTIFIER = {bundle};{match[2]}PRODUCT_NAME = iPortalRunner;'

    result = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);(\s*)PRODUCT_NAME = [^;]+;', replace, source)
    if count < 2:
        raise ValueError('Unsupported WDA project: missing runner build configurations')
    return result


if __name__ == '__main__':
    project = Path(sys.argv[1])
    project.write_text(configure(project.read_text(), sys.argv[2]))
