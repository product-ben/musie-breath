import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],

  server: {
    /**
     * 5180, PINNED, because port 5173 is somebody else's.
     *
     * The musie repo's dev server lives on 5173 and its playwright config
     * deliberately reuses whatever is already serving it. If this spike
     * defaulted to 5173 Vite would quietly take 5174 instead, and a tunnel
     * pointed at 5173 would then verify the wrong application — which is
     * exactly the trap musie's CLAUDE.md rule 9 describes.
     *
     * strictPort makes it refuse to start rather than quietly move, so the
     * tunnel URL below is always this app.
     */
    port: 5180,
    strictPort: true,

    /**
     * ── A TUNNEL, BECAUSE getUserMedia NEEDS HTTPS ────────────────────────
     * The microphone requires a secure context and `http://192.168.x.x:5180`
     * is NOT one — iOS Safari simply refuses, which reads as a broken app
     * rather than as a missing certificate. So device testing goes through:
     *
     *     cloudflared tunnel --url http://localhost:5180
     *
     * Vite then blocks the request, and rightly: `allowedHosts` is
     * DNS-rebinding protection. `.trycloudflare.com` — the leading dot covers
     * subdomains — rather than `true`, because a quick tunnel gets a fresh
     * random hostname every run and naming them one at a time is how this
     * ends up permanently open. Dev server only; nothing here reaches a build.
     */
    allowedHosts: ['.trycloudflare.com'],
  },
});
