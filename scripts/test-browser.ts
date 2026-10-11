import { install, computeExecutablePath, Browser, BrowserPlatform } from '@puppeteer/browsers'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Exact Chrome for Testing build; keep local acceptance and CI on the same browser.
const buildId = '154.0.8037.92'
const options = {
  browser: Browser.CHROME,
  platform: BrowserPlatform.MAC_ARM,
  buildId,
  cacheDir: fileURLToPath(new URL('../.task/browser', import.meta.url)),
}
export function testBrowserPath(): string {
  return computeExecutablePath(options)
}
if (import.meta.main) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Release acceptance currently supports macOS ARM64 only')
  }
  const browser = await install(options)
  console.log(browser.executablePath)
  if (process.env.GITHUB_ENV)
    appendFileSync(process.env.GITHUB_ENV, `CHROME_PATH=${browser.executablePath}\n`)
}
