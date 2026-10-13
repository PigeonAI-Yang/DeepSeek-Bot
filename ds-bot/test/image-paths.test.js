import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeWindowsMarkdownPaths } from '../src/client/text.js'

test('normalizes the Windows image destination from the preview failure', () => {
  const source = String.raw`![对比](<C:\Users\yangda01\.dsh\bot\workspace\compare_stair.png>)`
  const expected = '![对比](<C:/Users/yangda01/.dsh/bot/workspace/compare_stair.png>)'

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
  assert.equal(normalizeWindowsMarkdownPaths(expected), expected)
})

test('normalizes multiple drive paths without changing alt text or titles', () => {
  const source = String.raw`![alt\name](<D:\folder with spaces\frame (1).png> "title\name") ![second](E:\folder(two)\next.png)`
  const expected = '![alt\\name](<D:/folder with spaces/frame (1).png> "title\\name") ![second](E:/folder(two)/next.png)'

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('normalizes only drive-letter backslash separators in image destinations', () => {
  const source = String.raw`![mixed](C:\Users/x\one.png) ![forward](D:/already/forward.png) ![escaped separators](F:\\one\\two.png) ![relative](images\local.png) ![unc](\\server\share\image.png)`
  const expected = '![mixed](C:/Users/x/one.png) ![forward](D:/already/forward.png) ![escaped separators](F:/one/two.png) ![relative](images\\local.png) ![unc](\\\\server\\share\\image.png)'

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('leaves code spans and fenced code untouched', () => {
  const tick = String.fromCharCode(96)
  const source = [
    String.raw`![live](C:\live.png) ${tick}![inline](C:\inline.png)${tick} ${tick.repeat(2)}![double](C:\double.png)${tick.repeat(2)}`,
    '````md',
    String.raw`![fenced](C:\fenced.png)`,
    '```',
    String.raw`![still fenced](C:\still-fenced.png)`,
    '````',
    '~~~~txt',
    String.raw`![tilde fenced](C:\tilde.png)`,
    '~~~~',
    String.raw`![after](D:\after.png)`,
  ].join('\n')
  const expected = [
    String.raw`![live](C:/live.png) ${tick}![inline](C:\inline.png)${tick} ${tick.repeat(2)}![double](C:\double.png)${tick.repeat(2)}`,
    '````md',
    String.raw`![fenced](C:\fenced.png)`,
    '```',
    String.raw`![still fenced](C:\still-fenced.png)`,
    '````',
    '~~~~txt',
    String.raw`![tilde fenced](C:\tilde.png)`,
    '~~~~',
    String.raw`![after](D:/after.png)`,
  ].join('\n')

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('an unclosed fence protects the rest of the message', () => {
  const source = String.raw`![before](C:\before.png)
~~~js
![inside](D:\inside.png)`
  const expected = String.raw`![before](C:/before.png)
~~~js
![inside](D:\inside.png)`

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('honors escaped link and image openers and converts even-backslash openers', () => {
  const source = String.raw`\[escaped link](C:\escaped.png) \![escaped image](D:\escaped.png) \\[active link](E:\active.png) \\![active image](F:\active.png)`
  const expected = String.raw`\[escaped link](C:\escaped.png) \![escaped image](D:\escaped.png) \\[active link](E:/active.png) \\![active image](F:/active.png)`

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('leaves Windows file links in code spans and fences untouched', () => {
  const tick = String.fromCharCode(96)
  const source = [
    '[live](C:\\live.png)',
    tick + '[inline](D:\\inline.png)' + tick,
    '````md',
    '[fenced](E:\\fenced.png)',
    '```',
    '[still fenced](F:\\still-fenced.png)',
    '````',
    '[after](G:\\after.png)',
  ].join('\n')
  const expected = [
    '[live](C:/live.png)',
    tick + '[inline](D:\\inline.png)' + tick,
    '````md',
    '[fenced](E:\\fenced.png)',
    '```',
    '[still fenced](F:\\still-fenced.png)',
    '````',
    '[after](G:/after.png)',
  ].join('\n')

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
})

test('normalizes drive-letter file links and images in one pass', () => {
  const source = String.raw`[stair-legs-v2.png](<C:\Users\yangda01\.dsh\bot\workspace\stair-legs-v2.png>) [bare](D:\folder\frame.png) [title](<E:\folder with spaces\frame (1).png> "title\name") [line](F:\src\file.txt#L3) ![image](G:\images\preview.png)`
  const expected = '[stair-legs-v2.png](<C:/Users/yangda01/.dsh/bot/workspace/stair-legs-v2.png>) [bare](D:/folder/frame.png) [title](<E:/folder with spaces/frame (1).png> "title\\name") [line](F:/src/file.txt#L3) ![image](G:/images/preview.png)'

  assert.equal(normalizeWindowsMarkdownPaths(source), expected)
  assert.equal(normalizeWindowsMarkdownPaths(expected), expected)
})

test('leaves prose paths, remote destinations, and malformed syntax unchanged', () => {
  const source = String.raw`C:\prose\image.png [remote](https://example.test/image.png) [file](file:///C:\image.png) ![remote](https://example.test/image.png) [missing](C:\missing.png ![missing](C:\missing.png ![angle](<C:\unfinished.png) [title](C:\title.png "unfinished) ![escape](C:\bad\).png)`

  assert.equal(normalizeWindowsMarkdownPaths(source), source)
})

test('returns unchanged text when there are no Windows Markdown destinations', () => {
  for (const source of [
    '',
    'plain C:\\path\\image.png',
    '[relative](images/photo.png)',
    '[forward](C:/images/photo.png)',
    '[unc](\\\\server\\share\\photo.png)',
  ]) {
    assert.equal(normalizeWindowsMarkdownPaths(source), source)
  }
})
