/**
 * Landsat Timelapse for Lakes and Wetlands
 * ----------------------------------------
 * Builds a cloud-free seasonal Landsat composite for every year from 1984 on
 * and turns them into an animated GIF (and optionally an MP4 in Drive).
 * An optional outline traces the water edge (MNDWI > 0) in each frame, so
 * shoreline change is easy to follow.
 *
 * How to run
 *   Paste into https://code.earthengine.google.com, set the area and years in
 *   CONFIG, press Run. The animation appears in the Console with a link to
 *   the GIF; the MP4 export (if enabled) is in the Tasks tab.
 *
 * Author: Parisa Abbasalizadehrezaei · https://risarezaei.github.io
 * License: MIT
 */

// =============================== CONFIG ===================================
var CONFIG = {
  roi: ee.Geometry.Rectangle([44.95, 37.05, 46.05, 38.30]),  // example: Lake Urmia
  firstYear: 1985,
  lastYear: 2025,
  step: 1,                          // years between frames
  season: ['06-01', '09-30'],       // month-day window of each composite
  maxSceneCloud: 60,
  maxScenesPerPath: 6,              // clearest scenes per WRS path and year; keeps long animations within memory
  useLandsat7: false,               // true fills gaps but adds SLC-off stripes after 2003

  display: 'natural',               // 'natural' (red-green-blue) or 'false' (SWIR1-NIR-green)
  outlineWater: true,               // draw the MNDWI > 0 shoreline
  outlineColor: '00e5ff',

  dimensions: 600,                  // longest side of the animation, pixels
  framesPerSecond: 4,
  exportVideo: false,               // MP4 to Google Drive
  driveFolder: 'earthengine',
  filePrefix: 'landsat_timelapse'
};
// ==========================================================================

var roi = CONFIG.roi;
var NAMES = ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'];
var L57 = ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'];
var L89 = ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'];

function prepare(bands) {
  return function (img) {
    var qa = img.select('QA_PIXEL');
    var clear = qa.bitwiseAnd(1 << 1).eq(0).and(qa.bitwiseAnd(1 << 3).eq(0))
      .and(qa.bitwiseAnd(1 << 4).eq(0)).and(img.select('QA_RADSAT').eq(0));
    return img.select(bands, NAMES).multiply(0.0000275).add(-0.2).updateMask(clear)
      .copyProperties(img, ['system:time_start', 'WRS_PATH', 'CLOUD_COVER']);
  };
}

function landsat(year) {
  var s = ee.Date(year + '-' + CONFIG.season[0]);
  var e = ee.Date(year + '-' + CONFIG.season[1]).advance(1, 'day');
  function get(id, bands) {
    return ee.ImageCollection(id).filterBounds(roi).filterDate(s, e)
      .filter(ee.Filter.lt('CLOUD_COVER', CONFIG.maxSceneCloud)).map(prepare(bands));
  }
  var col = get('LANDSAT/LT05/C02/T1_L2', L57)
    .merge(get('LANDSAT/LC08/C02/T1_L2', L89))
    .merge(get('LANDSAT/LC09/C02/T1_L2', L89));
  if (CONFIG.useLandsat7) col = col.merge(get('LANDSAT/LE07/C02/T1_L2', L57));
  // Keep the clearest scenes of every WRS path, so areas that span two paths
  // stay complete while the number of scenes per frame stays small.
  var paths = col.aggregate_array('WRS_PATH').distinct();
  var keep = paths.map(function (p) {
    return col.filter(ee.Filter.eq('WRS_PATH', p)).sort('CLOUD_COVER')
      .limit(CONFIG.maxScenesPerPath).aggregate_array('system:index');
  }).flatten();
  return col.filter(ee.Filter.inList('system:index', keep));
}

var VIS = CONFIG.display === 'false'
  ? {bands: ['swir1', 'nir', 'green'], min: 0, max: 0.4, gamma: 1.1}
  : {bands: ['red', 'green', 'blue'], min: 0, max: 0.3, gamma: 1.2};

function frame(year) {
  var col = landsat(year);
  // Placeholder for years without scenes; those frames are filtered out below.
  var empty = ee.Image.constant([0, 0, 0, 0, 0, 0]).rename(NAMES).updateMask(0);
  var img = ee.Image(ee.Algorithms.If(col.size().gt(0), col.median(), empty)).clip(roi);
  var rgb = img.visualize(VIS);
  if (CONFIG.outlineWater) {
    var water = img.normalizedDifference(['green', 'swir1']).gt(0);
    var edge = water.focalMax(1).neq(water.focalMin(1)).selfMask();
    rgb = rgb.blend(edge.visualize({palette: [CONFIG.outlineColor]}));
  }
  return rgb.set({year: year, n_scenes: col.size(), 'system:time_start': ee.Date(year + '-07-01').millis()});
}

var years = [];
for (var y = CONFIG.firstYear; y <= CONFIG.lastYear; y += CONFIG.step) years.push(y);

// Years without any clear scene are dropped from the animation.
var frames = ee.ImageCollection(years.map(frame)).filter(ee.Filter.gt('n_scenes', 0));
print('Frames (one per year with data)', frames.aggregate_array('year'));

var params = {region: roi, dimensions: CONFIG.dimensions, framesPerSecond: CONFIG.framesPerSecond,
              crs: 'EPSG:3857'};
print(ui.Thumbnail(frames, params));
frames.getVideoThumbURL(params, function (url, err) {
  if (err) { print('GIF error', err); return; }
  print(ui.Label('Open / download the GIF', {color: '1e88e5'}, url));
});

Map.centerObject(roi, 9);
Map.addLayer(ee.Image(frames.sort('year', false).first()), {}, 'Last frame');

if (CONFIG.exportVideo) {
  Export.video.toDrive({
    collection: frames, description: CONFIG.filePrefix, folder: CONFIG.driveFolder,
    region: roi, dimensions: 1080, framesPerSecond: CONFIG.framesPerSecond, crs: 'EPSG:3857'
  });
}
