const { validateHeaderValue } = require('http');
const { downloadContentDisposition } = require('../content-disposition');
const AzureBlobClient = require('../storage-clients/AzureBlobClient');
const AliyunOSSClient = require('../storage-clients/AliyunOSSClient');

describe('download Content-Disposition', () => {
  test('preserves existing ASCII filenames and strips the object prefix', () => {
    expect(downloadContentDisposition('folder/demo.mp4')).toBe('attachment; filename="demo.mp4"');
    expect(downloadContentDisposition('folder/report (final).tar.gz')).toBe('attachment; filename="report (final).tar.gz"');
  });

  test.each([
    '沉淀物料包_MiniMax-H3竖屏短剧.tar.gz',
    'café résumé.pdf',
    "中文 O'Brien (final)*.zip",
    '🎬 version 100%.mp4',
    'report "final".txt',
    'literal%20name.txt',
    'back\\slash.txt'
  ])('encodes %s as UTF-8 while keeping the HTTP header ASCII', filename => {
    const header = downloadContentDisposition(`folder/${filename}`);
    expect(header).toMatch(/^attachment; filename="[^"\\\x00-\x1f\x7f-\uffff]+"; filename\*=UTF-8''/);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(() => validateHeaderValue('Content-Disposition', header)).not.toThrow();
    const encoded = header.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe(filename);
    // RFC 5987 attr-char excludes apostrophes, parentheses and asterisks,
    // even though encodeURIComponent normally leaves them untouched.
    expect(encoded).not.toMatch(/['()*]/);
  });

  test('the previous raw Chinese header is invalid even if the URL encoded it', () => {
    const query = new URLSearchParams({ 'response-content-disposition': 'attachment; filename="中文.zip"' });
    const decoded = new URLSearchParams(query.toString()).get('response-content-disposition');
    expect(() => validateHeaderValue('Content-Disposition', decoded)).toThrow();
  });

  test('control characters cannot inject another header or parameter', () => {
    const header = downloadContentDisposition('folder/中文\r\n"; injected=true\u0000.txt');
    expect(header).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1])).toBe('中文__"; injected=true_.txt');
  });

  test('handles an empty basename and malformed Unicode without throwing', () => {
    expect(downloadContentDisposition('folder/')).toBe('attachment; filename="download"');
    expect(downloadContentDisposition('bad\ud800.txt')).toContain('filename*=UTF-8\'\'bad%EF%BF%BD.txt');
  });
});

// Both SDKs sign locally with synthetic credentials; no cloud requests occur.
describe('Azure and OSS download URL encoding', () => {
  const filename = '中文 "final" (1).tar.gz';
  const key = `folder/${filename}`;
  const clients = [
    ['Azure', 'rscd', () => new AzureBlobClient().initialize({
      accountName: 'fixtureaccount', accountKey: Buffer.alloc(32).toString('base64')
    })],
    ['OSS', 'response-content-disposition', () => new AliyunOSSClient().initialize({
      accessKey: 'fixture-key', secretKey: 'fixture-secret', region: 'oss-cn-hangzhou', bucket: 'fixture-bucket'
    })]
  ];

  test.each(clients)('%s signs a Unicode name with a valid response header', async (_, parameter, createClient) => {
    const client = createClient();
    const parsed = new URL(await client.getObjectUrl('fixture-bucket', key, 'download'));
    const disposition = parsed.searchParams.get(parameter);
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(filename);
    expect(decodeURIComponent(parsed.pathname)).toContain(key);
  });

  test.each(clients)('%s preview does not force an attachment', async (_, parameter, createClient) => {
    const parsed = new URL(await createClient().getObjectUrl('fixture-bucket', key, 'view'));
    expect(parsed.searchParams.get(parameter)).toBeNull();
  });
});
