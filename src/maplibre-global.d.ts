// MapLibre is loaded as a UMD script from /vendor (see index.html): its inline
// blob worker does not survive Vite's dependency pre-bundling.
declare const maplibregl: typeof import('maplibre-gl');
