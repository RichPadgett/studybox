import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ["studybox.enochscalendar.com"],
    proxy: {
      // xfwd: pass the phone's address to the API, which lets a phone on the
      // StudyBox-Setup hotspot add Wi-Fi without the admin PIN.
      "/api": { target: "http://127.0.0.1:4000", xfwd: true }
    }
  }
});
