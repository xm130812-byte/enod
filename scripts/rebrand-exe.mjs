#!/usr/bin/env node
/**
 * 给 SEA 产物"正名"：替换 PE 里的版本信息与图标。
 *
 * Node SEA 直接复制 node.exe 再注入 blob，所以文件属性里写着
 * ProductName = Node.js、OriginalFilename = node.exe ——
 * 企业终端管控按软件名判断时会被当成"安装 Node.js"。
 *
 * 用法：node scripts/rebrand-exe.mjs <输入 exe> <输出 exe> [图标 ico]
 */
import fs from 'node:fs';
import * as ResEdit from 'resedit';

const [input, output, iconPath] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/rebrand-exe.mjs <in.exe> <out.exe> [icon.ico]');
  process.exit(1);
}

const VERSION = '0.1.0';
const META = {
  CompanyName: 'md-reader',
  ProductName: 'md-reader',
  FileDescription: 'md-reader local reader',
  InternalName: 'md-reader',
  OriginalFilename: 'md-reader.exe',
  LegalCopyright: 'Private use',
  FileVersion: VERSION,
  ProductVersion: VERSION,
};

const exe = ResEdit.NtExecutable.from(fs.readFileSync(input), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

// 1. 版本信息：所有语言的字符串表都改写，确保没有残留的 "Node.js"
const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (versionInfos.length === 0) throw new Error('没有找到版本信息资源');
let touched = 0;
for (const info of versionInfos) {
  const languages = info.getAllLanguagesForStringValues();
  for (const language of languages.length > 0 ? languages : [{ lang: 1033, codepage: 1200 }]) {
    info.setStringValues(language, META, false);
    touched++;
  }
  info.setFileVersion(VERSION);
  info.setProductVersion(VERSION);
  info.outputToResourceEntries(res.entries);
}
console.log(`[rebrand] 改写 ${touched} 张字符串表`);

// 2. 图标：替换所有图标组，避免沿用 node.exe 的图标
if (iconPath && fs.existsSync(iconPath)) {
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      group.id,
      group.lang,
      iconFile.icons.map((item) => item.data),
    );
  }
  console.log(`[rebrand] 替换 ${groups.length} 组图标`);
}

res.outputResource(exe);
fs.writeFileSync(output, Buffer.from(exe.generate()));
const size = fs.statSync(output).size;
console.log(`[rebrand] 输出 ${output}（${(size / 1024 / 1024).toFixed(1)} MB）`);
