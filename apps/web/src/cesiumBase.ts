/**
 * Tells CesiumJS where its static assets (workers, default imagery, widget images) are served from.
 * This has to be set before Cesium is first used, so it is the first import of the application.
 */
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium/';

export {};
