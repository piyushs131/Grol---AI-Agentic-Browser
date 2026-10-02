const cp = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { CapabilityModule } = require('../../shared/schemas/capability-schema');
const { runPowerShellAsync } = require('../process/windows-apps');
const macInput = require('../desktop/mac-input');

let screenshotDesktop = null;
try {
  screenshotDesktop = require('screenshot-desktop');
} catch {}

const FORMATS = { png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const MAX_ANALYZE_WIDTH = 8192;
const DEFAULT_QUALITY = 60;

function run(file, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(file, args, { timeout: 15000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${file} failed: ${String(stderr || err.message).trim()}`));
      resolve(String(stdout));
    });
  });
}

const ps = (script, vars) => runPowerShellAsync(script, { timeoutMs: 15000, vars });

const safeFilename = (name, fallback) => {
  const base = path.basename(String(name || ''));
  return /^[\w.-]+$/.test(base) && !base.startsWith('.') ? base : fallback;
};

const uniqueName = (prefix, ext) => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;

function toFormat(format = 'png') {
  const f = FORMATS[String(format).toLowerCase()];
  if (!f) throw new Error(`format must be one of ${Object.keys(FORMATS).join(', ')}`);
  return f;
}

function toRegion({ x, y, width, height } = {}) {
  const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
  const region = { x: Math.round(num(x)), y: Math.round(num(y)),
    width: Math.round(num(width)), height: Math.round(num(height)) };
  if (!Object.values(region).every(Number.isFinite) || region.width <= 0 || region.height <= 0 ||
      Object.values(region).some((v) => Math.abs(v) > 100000)) {
    throw new Error('x, y, width, and height must be numbers (width and height positive)');
  }
  return region;
}

function toAnalyzeWidth(width) {
  if (width === undefined || width === null) return undefined;
  const n = Number(width);
  if (!Number.isFinite(n) || n < 1 || n > MAX_ANALYZE_WIDTH) {
    throw new Error(`width must be a number between 1 and ${MAX_ANALYZE_WIDTH}`);
  }
  return Math.round(n);
}

function toQuality(quality) {
  const n = Number(quality);
  if (quality === undefined || quality === null || !Number.isFinite(n)) return DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, Math.round(n)));
}

const PS_CAPTURE = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($env:GROL_REGION -eq '1') {
  $b = New-Object System.Drawing.Rectangle([int]$env:GROL_X, [int]$env:GROL_Y, [int]$env:GROL_W, [int]$env:GROL_H)
}
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($env:GROL_FILE)
$g.Dispose()
$bmp.Dispose()`;

async function captureScreen(platform, filePath) {
  if (platform === 'darwin') return run('screencapture', ['-x', filePath]);
  if (platform === 'win32') return ps(PS_CAPTURE, { REGION: 0, FILE: filePath });
  try { return await run('scrot', ['-o', filePath]); }
  catch (_) { return run('import', ['-window', 'root', filePath]); }
}

async function captureRegion(platform, filePath, { x, y, width, height }) {
  if (platform === 'darwin') return run('screencapture', ['-x', `-R${x},${y},${width},${height}`, filePath]);
  if (platform === 'win32') return ps(PS_CAPTURE, { REGION: 1, X: x, Y: y, W: width, H: height, FILE: filePath });
  try { return await run('import', ['-window', 'root', '-crop', `${width}x${height}+${x}+${y}`, filePath]); }
  catch (_) { return run('scrot', ['-o', '-a', `${x},${y},${width},${height}`, filePath]); }
}

function readAndRemove(filePath) {
  try { return fs.readFileSync(filePath); }
  finally { fs.rmSync(filePath, { force: true }); }
}

class ScreenModule extends CapabilityModule {
  constructor() {
    super('screen', 'Screenshot capture and screen analysis');
  }

  async initialize(context = {}) {
    await super.initialize(context);
    this.platform = context.platform || process.platform;
    this.dataDir = context.dataDir || os.tmpdir();
    this.screenshotDir = path.join(this.dataDir, 'screenshots');
    fs.mkdirSync(this.screenshotDir, { recursive: true });

    this.registerAction('takeScreenshot', this.takeScreenshot, {
      description: 'Capture a screenshot of the entire screen',
      parameters: ['filename', 'format'],
      riskLevel: 'low'
    });

    this.registerAction('takeRegionScreenshot', this.takeRegionScreenshot, {
      description: 'Capture a screenshot of a specific screen region',
      parameters: ['x', 'y', 'width', 'height', 'filename'],
      riskLevel: 'low'
    });

    this.registerAction('listScreenshots', this.listScreenshots, {
      description: 'List all captured screenshots',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('getScreenInfo', this.getScreenInfo, {
      description: 'Get display/screen information',
      parameters: [],
      riskLevel: 'low'
    });

    this.registerAction('analyzeScreen', this.analyzeScreen, {
      description: 'Capture and analyze screen content (returns base64 image for AI processing)',
      parameters: ['region', 'width', 'quality'],
      riskLevel: 'low'
    });

    this.registerAction('findOnScreen', this.findOnScreen, {
      description: 'Describe what is visible on screen (requires vision API)',
      parameters: ['query'],
      riskLevel: 'low'
    });

    this.registerAction('getDisplays', this.getScreenInfo, {
      description: 'Get information about connected displays',
      parameters: [],
      riskLevel: 'low'
    });
  }

  async takeScreenshot({ filename, format = 'png' } = {}) {
    const ext = toFormat(format);
    const fname = safeFilename(filename, uniqueName('screenshot', ext));
    const filePath = path.join(this.screenshotDir, fname);

    if (screenshotDesktop) {
      const imgBuffer = await screenshotDesktop({ format: ext });
      fs.writeFileSync(filePath, imgBuffer);
      return {
        path: filePath,
        filename: fname,
        size: imgBuffer.length,
        format: ext,
        base64Preview: imgBuffer.toString('base64').substring(0, 200) + '...'
      };
    }

    await captureScreen(this.platform, filePath);
    return { path: filePath, filename: fname, size: fs.statSync(filePath).size, format: ext };
  }

  async takeRegionScreenshot({ x, y, width, height, filename } = {}) {
    const region = toRegion({ x, y, width, height });
    const fname = safeFilename(filename, uniqueName('region', 'png'));
    const filePath = path.join(this.screenshotDir, fname);
    await captureRegion(this.platform, filePath, region);
    return { path: filePath, filename: fname, size: fs.statSync(filePath).size, region };
  }

  async listScreenshots() {
    const files = fs.readdirSync(this.screenshotDir)
      .filter((f) => /\.(png|jpg|jpeg|bmp)$/i.test(f))
      .flatMap((f) => {
        const filePath = path.join(this.screenshotDir, f);
        try {
          const stat = fs.statSync(filePath);
          return [{ filename: f, path: filePath, size: stat.size, created: stat.birthtime.toISOString() }];
        } catch (_) {
          return [];
        }
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    return { screenshots: files, count: files.length, directory: this.screenshotDir };
  }

  async getScreenInfo() {
    if (this.platform === 'darwin') {
      const displays = await macInput.displays();
      return { displays, count: displays.length };
    }
    if (this.platform !== 'win32') {
      return { displays: [{ width: 1920, height: 1080, primary: true, note: 'Estimated' }], count: 1 };
    }
    try {
      const result = await ps(`
Add-Type -AssemblyName System.Windows.Forms
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  "$($s.DeviceName)|$($s.Bounds.Width)|$($s.Bounds.Height)|$($s.Primary)|$($s.BitsPerPixel)"
}`);
      const displays = result.trim().split('\n').map((line) => {
        const [name, width, height, primary, bpp] = line.trim().split('|');
        return {
          name: name?.trim(),
          width: parseInt(width, 10),
          height: parseInt(height, 10),
          primary: primary?.trim() === 'True',
          bitsPerPixel: parseInt(bpp, 10)
        };
      }).filter((d) => d.width > 0);
      return { displays, count: displays.length };
    } catch (_) {
      return { displays: [{ width: 1920, height: 1080, primary: true, note: 'fallback' }], count: 1 };
    }
  }

  async analyzeScreen({ region, width, quality } = {}) {
    const targetWidth = toAnalyzeWidth(width);
    if (!region && targetWidth && this.platform === 'darwin') {
      const tempPath = path.join(this.screenshotDir, uniqueName('analyze', 'jpg'));
      try {
        await run('screencapture', ['-x', '-t', 'jpg', tempPath]);
        await run('sips', ['--resampleWidth', String(targetWidth), '-s', 'formatOptions', String(toQuality(quality)), tempPath]);
      } catch (err) {
        fs.rm(tempPath, { force: true }, () => {});
        throw err;
      }
      const imgBuffer = readAndRemove(tempPath);
      return {
        base64: imgBuffer.toString('base64'),
        size: imgBuffer.length,
        format: 'jpeg',
        width: targetWidth,
        timestamp: Date.now()
      };
    }

    let imgBuffer;
    if (region) {
      const result = await this.takeRegionScreenshot(region);
      imgBuffer = readAndRemove(result.path);
    } else if (screenshotDesktop) {
      imgBuffer = await screenshotDesktop({ format: 'png' });
    } else {
      const tempPath = path.join(this.screenshotDir, uniqueName('analyze', 'png'));
      try { await captureScreen(this.platform, tempPath); }
      catch (err) { fs.rm(tempPath, { force: true }, () => {}); throw err; }
      imgBuffer = readAndRemove(tempPath);
    }

    return {
      base64: imgBuffer.toString('base64'),
      size: imgBuffer.length,
      format: 'png',
      note: 'Send this base64 image to a vision AI model for analysis',
      timestamp: Date.now()
    };
  }

  async findOnScreen({ query } = {}) {
    if (!query) throw new Error('Query description is required');
    const screenData = await this.analyzeScreen();
    return {
      query,
      screenshotSize: screenData.size,
      base64: screenData.base64,
      note: 'Pass this screenshot to a vision AI model with the query to locate UI elements',
      instruction: `Analyze this screenshot and find: "${query}". Return the coordinates (x, y) of the element.`
    };
  }
}

ScreenModule.captureScreen = captureScreen;

module.exports = ScreenModule;
module.exports.__test = { toRegion, toFormat, toAnalyzeWidth, toQuality, safeFilename };
