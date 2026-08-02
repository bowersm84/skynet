import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @kenjiuno/msgreader (Outlook .msg parsing on the STC intake dropzone,
      // D-KSTC-18) pulls in iconv-lite → safer-buffer → require('buffer'), and
      // iconv-lite's encodings → require('string_decoder'). Vite otherwise
      // externalizes both node builtins to an EMPTY namespace, and safer-buffer
      // reads `Buffer.prototype` off it at module-evaluation time — an
      // undefined dereference that takes the whole bundle down on load, not
      // just the .msg path. These aliases point them at the real browser
      // polyfills. Verified by the build no longer warning about either module.
      buffer: 'buffer',
      string_decoder: 'string_decoder',
    },
  },
})
