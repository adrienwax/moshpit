import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('sources', Path(__file__).with_name('prepare-sources.py'))
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class SourceExtraction(unittest.TestCase):
    def test_rejects_traversal_and_windows_paths(self):
        for name in ('../outside', '/outside', 'root/../../outside', 'C:/outside', 'root\\..\\outside'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                sources.safe_parts(name)

    def test_extracts_only_inside_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root/'source.zip'
            with zipfile.ZipFile(str(archive), 'w') as z:
                z.writestr('source/code.c', 'source bytes')
                z.writestr('../escape.c', 'unsafe')
            with self.assertRaises(ValueError):
                sources.extract(archive, root/'out')
            self.assertEqual((root/'out/code.c').read_text(), 'source bytes')
            self.assertFalse((root/'escape.c').exists())

    def test_resolves_internal_documentation_link_without_symlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root/'source.zip'
            with zipfile.ZipFile(str(archive), 'w') as z:
                z.writestr('source/include/a.h', 'header bytes')
                info = zipfile.ZipInfo('source/doc/a.h')
                info.create_system = 3
                info.external_attr = 0o120777 << 16
                z.writestr(info, '../include/a.h')
            sources.extract(archive, root/'out')
            self.assertEqual((root/'out/doc/a.h').read_text(), 'header bytes')
            self.assertFalse((root/'out/doc/a.h').is_symlink())

    def test_rejects_link_outside_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root/'source.zip'
            with zipfile.ZipFile(str(archive), 'w') as z:
                info = zipfile.ZipInfo('source/a.h')
                info.create_system = 3
                info.external_attr = 0o120777 << 16
                z.writestr(info, '../outside.h')
            with self.assertRaises(ValueError):
                sources.extract(archive, root/'out')


if __name__ == '__main__':
    unittest.main()
