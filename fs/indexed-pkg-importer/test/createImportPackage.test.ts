import fs from 'fs'
import path from 'path'
import { createIndexedPkgImporter } from '@pnpm/fs.indexed-pkg-importer'
import gfs from '@pnpm/graceful-fs'
import { globalInfo } from '@pnpm/logger'

jest.mock('@pnpm/graceful-fs', () => {
  const { access, promises } = jest.requireActual('fs')
  const fsMock = {
    mkdirSync: promises.mkdir,
    readdirSync: promises.readdir,
    access,
    copyFileSync: jest.fn(),
    linkSync: jest.fn(),
    statSync: jest.fn(),
  }
  return {
    __esModule: true,
    default: fsMock,
  }
})
jest.mock('path-temp', () => ({ fastPathTemp: (file: string) => `${file}_tmp` }))
jest.mock('rename-overwrite', () => ({ sync: jest.fn() }))
jest.mock('fs-extra', () => ({
  copySync: jest.fn(),
}))
jest.mock('@pnpm/logger', () => ({
  logger: jest.fn(() => ({ debug: jest.fn() })),
  globalWarn: jest.fn(),
  globalInfo: jest.fn(),
}))

beforeEach(() => {
  ;(gfs.copyFileSync as jest.Mock).mockClear()
  ;(gfs.linkSync as jest.Mock).mockClear()
  ;(globalInfo as jest.Mock).mockReset()
})

test('packageImportMethod=auto: clone files by default', () => {
  const importPackage = createIndexedPkgImporter('auto')
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: false,
  })).toBe('clone')
  expect(gfs.copyFileSync).toBeCalledWith(
    path.join('hash1'),
    path.join('project', 'package_tmp', 'package.json'),
    fs.constants.COPYFILE_FICLONE_FORCE
  )
  expect(gfs.copyFileSync).toBeCalledWith(
    path.join('hash2'),
    path.join('project', 'package_tmp', 'index.js'),
    fs.constants.COPYFILE_FICLONE_FORCE
  )
})

test('packageImportMethod=auto: link files if cloning fails', () => {
  const importPackage = createIndexedPkgImporter('auto')
  ;(gfs.copyFileSync as jest.Mock).mockImplementation(() => {
    throw new Error('This file system does not support cloning')
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: false,
  })).toBe('hardlink')
  expect(gfs.linkSync).toBeCalledWith(path.join('hash1'), path.join('project', 'package_tmp', 'package.json'))
  expect(gfs.linkSync).toBeCalledWith(path.join('hash2'), path.join('project', 'package_tmp', 'index.js'))
  expect(gfs.copyFileSync).toBeCalled()
  ;(gfs.copyFileSync as jest.Mock).mockClear()

  // The copy function will not be called again
  expect(importPackage('project2/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: false,
  })).toBe('hardlink')
  expect(gfs.copyFileSync).not.toBeCalled()
  expect(gfs.linkSync).toBeCalledWith(path.join('hash1'), path.join('project2', 'package_tmp', 'package.json'))
  expect(gfs.linkSync).toBeCalledWith(path.join('hash2'), path.join('project2', 'package_tmp', 'index.js'))
})

test('packageImportMethod=auto: link files if cloning fails and even hard linking fails but not with EXDEV error', () => {
  const importPackage = createIndexedPkgImporter('auto')
  ;(gfs.copyFileSync as jest.Mock).mockImplementation(() => {
    throw new Error('This file system does not support cloning')
  })
  let linkFirstCall = true
  ;(gfs.linkSync as jest.Mock).mockImplementation(() => {
    if (linkFirstCall) {
      linkFirstCall = false
      throw new Error()
    }
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
    },
    force: false,
    fromStore: false,
  })).toBe('hardlink')
  expect(gfs.linkSync).toBeCalledWith(path.join('hash2'), path.join('project', 'package_tmp', 'index.js'))
  expect(gfs.linkSync).toBeCalledTimes(2)
  expect(gfs.copyFileSync).toBeCalledTimes(1)
})

test('packageImportMethod=auto: chooses copying if cloning and hard linking is not possible', () => {
  const importPackage = createIndexedPkgImporter('auto')
  ;(gfs.copyFileSync as jest.Mock).mockImplementation((src: string, dest: string, flags?: number) => {
    if (flags === fs.constants.COPYFILE_FICLONE_FORCE) {
      throw new Error('This file system does not support cloning')
    }
  })
  ;(gfs.linkSync as jest.Mock).mockImplementation(() => {
    throw new Error('EXDEV: cross-device link not permitted')
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
    },
    force: false,
    fromStore: false,
  })).toBe('copy')
  expect(gfs.copyFileSync).toBeCalledWith(path.join('hash2'), path.join('project', 'package_tmp', 'index.js'))
  expect(gfs.copyFileSync).toBeCalledTimes(2)
})

test('packageImportMethod=hardlink: fall back to copying if hardlinking fails', () => {
  const importPackage = createIndexedPkgImporter('hardlink')
  ;(gfs.linkSync as jest.Mock).mockImplementation((src: string, dest: string) => {
    if (dest.endsWith('license')) {
      throw Object.assign(new Error(''), { code: 'EEXIST' })
    }
    throw new Error('This file system does not support hard linking')
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
      license: 'hash3',
    },
    force: false,
    fromStore: false,
  })).toBe('hardlink')
  expect(gfs.linkSync).toBeCalledTimes(3)
  expect(gfs.copyFileSync).toBeCalledTimes(2) // One time the target already exists, so it won't be copied
  expect(gfs.copyFileSync).toBeCalledWith(path.join('hash1'), path.join('project', 'package_tmp', 'package.json'))
  expect(gfs.copyFileSync).toBeCalledWith(path.join('hash2'), path.join('project', 'package_tmp', 'index.js'))
})

test('packageImportMethod=hardlink does not relink package from store if package.json is linked from the store', () => {
  const importPackage = createIndexedPkgImporter('hardlink')
  ;(gfs.statSync as jest.Mock).mockReturnValue({ ino: 1 })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: true,
  })).toBe(undefined)
})

test('packageImportMethod=hardlink relinks package from store if package.json is not linked from the store', () => {
  const importPackage = createIndexedPkgImporter('hardlink')
  let ino = 0
  ;(gfs.statSync as jest.Mock).mockImplementation(() => ({ ino: ++ino }))
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: true,
  })).toBe('hardlink')
  expect(globalInfo).toBeCalledWith('Relinking project/package from the store')
})

test('packageImportMethod=hardlink does not relink package from store if package.json is not present in the store', () => {
  const importPackage = createIndexedPkgImporter('hardlink')
  ;(gfs.statSync as jest.Mock).mockImplementation((file) => {
    expect(typeof file).toBe('string')
    return { ino: 1 }
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
    },
    force: false,
    fromStore: true,
  })).toBe(undefined)
})

test('packageImportMethod=hardlink links packages when they are not found', () => {
  const importPackage = createIndexedPkgImporter('hardlink')
  ;(gfs.statSync as jest.Mock).mockImplementation((file) => {
    if (file === path.join('project/package', 'package.json')) {
      throw Object.assign(new Error(), { code: 'ENOENT' })
    }
    return { ino: 0 }
  })
  expect(importPackage('project/package', {
    filesMap: {
      'index.js': 'hash2',
      'package.json': 'hash1',
    },
    force: false,
    fromStore: true,
  })).toBe('hardlink')
  expect(globalInfo).not.toBeCalledWith('Relinking project/package from the store')
})
