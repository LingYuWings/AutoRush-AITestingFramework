"""Check runtime class definitions, not merely referenced DEX strings."""
import argparse
import struct
import zipfile


def defined_classes(data):
    strings_size, strings_off = struct.unpack_from('<II', data, 56)
    types_size, types_off = struct.unpack_from('<II', data, 64)
    classes_size, classes_off = struct.unpack_from('<II', data, 96)
    strings = []
    for index in range(strings_size):
        offset = struct.unpack_from('<I', data, strings_off + index * 4)[0]
        while data[offset] & 128:
            offset += 1
        offset += 1
        strings.append(data[offset:data.index(b'\0', offset)].decode('utf-8', errors='replace'))
    types = [strings[struct.unpack_from('<I', data, types_off + index * 4)[0]] for index in range(types_size)]
    return {types[struct.unpack_from('<I', data, classes_off + index * 32)[0]] for index in range(classes_size)}


def verify(path):
    with zipfile.ZipFile(path) as apk:
        classes = set().union(*(defined_classes(apk.read(name)) for name in apk.namelist() if name.endswith('.dex')))
    required = {'Lcom/journeyapps/barcodescanner/CaptureActivity;',
                'Landroidx/core/content/ContextCompat;', 'Landroidx/core/app/ActivityCompat;'}
    missing = required - classes
    if missing:
        raise SystemExit('Missing scanner runtime definitions: ' + ', '.join(sorted(missing)))
    print('Scanner runtime class definitions verified')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('apk')
    verify(parser.parse_args().apk)
