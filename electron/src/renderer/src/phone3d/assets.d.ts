// Vite inlines `?inline` imports as a base64 data URL string (the HDRI, phone3d/hdri.ts).
declare module '*.hdr?inline' {
  const dataUrl: string;
  export default dataUrl;
}
