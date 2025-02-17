/*
 * Copyright 2019 Akihiko Kusanagi
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 *
 * More information about this project is available at:
 *
 *    https://github.com/nagix/mini-tokyo-3d
 */

// Standing duration at origin in milliseconds
var STANDING_DURATION = 60000;

// Minimum standing duration in milliseconds
var MIN_STANDING_DURATION = 30000;

// Interval of refreshing train positions in milliseconds
var TRAIN_REFRESH_INTERVAL = 60000;

// Maximum train speed in km/h
var MAX_SPEED_KMPH = 80;

// Train acceleration in km/h/s
var ACCELERATION_KMPHPS = 3;

// Time factor for the non-real-time mode
var TIME_FACTOR = 12;

var MAX_SPEED = MAX_SPEED_KMPH / 3600000;
var ACCELERATION = ACCELERATION_KMPHPS / 3600000000;
var MAX_ACCELERATION_TIME = MAX_SPEED / ACCELERATION;
var MAX_ACC_DISTANCE = MAX_ACCELERATION_TIME * MAX_SPEED / 2;

// Maximum flight speed in km/h
var MAX_FLIGHT_SPEED_KMPH = 500;

// Flight acceleration in km/h/s
var FLIGHT_ACCELERATION_KMPHPS = 12;

var MAX_FLIGHT_SPEED = MAX_FLIGHT_SPEED_KMPH / 3600000;
var FLIGHT_ACCELERATION = FLIGHT_ACCELERATION_KMPHPS / 3600000000;

// Delay in milliseconds for precision error
var MIN_DELAY = 25000;

// Minimum flight interval in milliseconds
var MIN_FLIGHT_INTERVAL = 90000;

// API URL
var API_URL = 'https://api-tokyochallenge.odpt.org/api/v4/';

var SQRT3 = Math.sqrt(3);
var DEGREE_TO_RADIAN = Math.PI / 180;

var modelOrigin = mapboxgl.MercatorCoordinate.fromLngLat([139.7670, 35.6814]);
var modelScale = 1 / 2 / Math.PI / 6378137 / Math.cos(35.6814 * DEGREE_TO_RADIAN);

var lang = getLang();
var isEdge = navigator.userAgent.indexOf('Edge') !== -1;
var isUndergroundVisible = false;
var isRealtime = true;
var isWeatherVisible = false;
var rainTexture = new THREE.TextureLoader().load('images/raindrop.png');
var trackingMode = 'helicopter';
var styleColors = [];
var styleOpacities = [];
var emitterBounds = {};
var emitterQueue = [];
var animations = {};
var featureLookup = {};
var activeTrainLookup = {};
var realtimeTrainLookup = {};
var flightLookup = {};
var activeFlightLookup = {};
var animationID = 0;
var lastStaticUpdate = '2019-11-13 02:22:08';
var lastDynamicUpdate = {};
var stationLookup, stationTitleLookup, railwayLookup, railDirectionLookup, trainTypeLookup, trainLookup, operatorLookup, airportLookup, a;
var trackedObject, markedObject, lastTimetableRefresh, lastTrainRefresh, lastFrameRefresh, trackingBaseBearing, viewAnimationID, layerZoom, altitudeUnit, objectUnit, objectScale, carScale, aircraftScale;
var lastNowCastRefresh, nowCastData, fgGroup, imGroup, bgGroup;

// Replace MapboxLayer.render to support underground rendering
var render = MapboxLayer.prototype.render;
MapboxLayer.prototype.render = function(gl, matrix) {
	var deck = this.deck;
	var map = this.map;
	var center = map.getCenter();

	if (!deck.layerManager) {
		// Not yet initialized
		return;
	}

	if (!deck.props.userData.currentViewport) {
		deck.props.userData.currentViewport = new WebMercatorViewport({
			x: 0,
			y: 0,
			width: deck.width,
			height: deck.height,
			longitude: center.lng,
			latitude: center.lat,
			zoom: map.getZoom(),
			bearing: map.getBearing(),
			pitch: map.getPitch(),
			nearZMultiplier: 0,
			farZMultiplier: 10
		});
	}
	render.apply(this, arguments);
};

var MapboxGLButtonControl = function(options) {
	this.initialize(options);
};

MapboxGLButtonControl.prototype.initialize = function(optionArray) {
	this._options = optionArray.map(function(options) {
		return {
			className: options.className || '',
			title: options.title || '',
			eventHandler: options.eventHandler
		};
	});
};

MapboxGLButtonControl.prototype.onAdd = function(map) {
	var me = this;

	me._map = map;

	me._container = document.createElement('div');
	me._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

	me._buttons = me._options.map(function(options) {
		var button = document.createElement('button');

		button.className = 'mapboxgl-ctrl-icon ' + options.className;
		button.type = 'button';
		button.title = options.title;
		button.onclick = options.eventHandler;

		me._container.appendChild(button);

		return button;
	});

	return me._container;
};

MapboxGLButtonControl.prototype.onRemove = function() {
	var me = this;

	me._container.parentNode.removeChild(me._container);
	me._map = undefined;
};

var ThreeLayer = function(id) {
	this.initialize(id);
}

ThreeLayer.prototype.initialize = function(id) {
	this.id = id;
	this.type = 'custom';
	this.renderingMode = '3d';
};

ThreeLayer.prototype.onAdd = function(map, gl) {
	var renderer = this.renderer = new THREE.WebGLRenderer({
		canvas: map.getCanvas(),
		context: gl
	});
	var scene = this.scene = new THREE.Scene();
	var light = this.light = new THREE.DirectionalLight(0xffffff, .8);

	renderer.autoClear = false;

	scene.add(light);
	scene.add(new THREE.AmbientLight(0xffffff, .4));

	// This is needed to avoid a black screen with empty scene
	scene.add(new THREE.Mesh());

	this.map = map;
	this.camera = new THREE.PerspectiveCamera(map.transform._fov / DEGREE_TO_RADIAN, window.innerWidth / window.innerHeight);
	this.raycaster = new THREE.Raycaster();
};

ThreeLayer.prototype.render = function(gl, matrix) {
	var id = this.id;
	var map = this.map;
	var renderer = this.renderer;
	var camera = this.camera;
	var transform = map.transform;
	var halfFov = transform._fov / 2;
	var cameraToCenterDistance = transform.cameraToCenterDistance;
	var angle = Math.PI / 2 - transform._pitch;
	var topHalfSurfaceDistance = Math.sin(halfFov) * cameraToCenterDistance / Math.sin(angle - halfFov);
	var furthestDistance = Math.cos(angle) * topHalfSurfaceDistance + cameraToCenterDistance;
	var nearZ = transform.height / 50;
	var halfHeight = Math.tan(halfFov) * nearZ;
	var halfWidth = halfHeight * transform.width / transform.height;

	var m = new THREE.Matrix4().fromArray(matrix);
	var l = new THREE.Matrix4()
		.makeTranslation(modelOrigin.x, modelOrigin.y, 0)
		.scale(new THREE.Vector3(1, -1, 1));

	var projectionMatrixI = new THREE.Matrix4();

	camera.projectionMatrix = new THREE.Matrix4().makePerspective(
		-halfWidth, halfWidth, halfHeight, -halfHeight, nearZ, furthestDistance * 1.01);
	projectionMatrixI.getInverse(camera.projectionMatrix);
	camera.matrix.getInverse(projectionMatrixI.multiply(m).multiply(l));
	camera.matrix.decompose(camera.position, camera.quaternion, camera.scale);

	if (id.indexOf('-ug', id.length - 3) !== -1 && isUndergroundVisible) {
		// Recalculate the projection matrix to replace the far plane
		camera.projectionMatrix = new THREE.Matrix4().makePerspective(
			-halfWidth, halfWidth, halfHeight, -halfHeight, nearZ, furthestDistance * 2.5);
	}

	var rad = (map.getBearing() + 30) * DEGREE_TO_RADIAN;
	this.light.position.set(-Math.sin(rad), -Math.cos(rad), SQRT3).normalize();

	renderer.state.reset();
	renderer.render(this.scene, camera);
	map.triggerRepaint();
};

ThreeLayer.prototype.onResize = function(event) {
	var camera = this.camera;
	var transform = event.target.transform;

	camera.aspect = transform.width / transform.height;
	camera.updateProjectionMatrix();
};

ThreeLayer.prototype.pickObject = function(point) {
	var mouse = new THREE.Vector2(
		(point.x / window.innerWidth) * 2 - 1,
		-(point.y / window.innerHeight) * 2 + 1
	);
	var raycaster = this.raycaster;
	var intersects, i;

	raycaster.setFromCamera(mouse, this.camera);
	intersects = raycaster.intersectObjects(this.scene.children);
	for (i = 0; i < intersects.length; i++) {
		if (intersects[i].object.userData.coord) {
			return intersects[i].object;
		}
	}
};

Promise.all([
	loadJSON('data/dictionary-' + lang + '.json'),
	loadJSON('data/railways.json'),
	loadJSON('data/stations.json'),
	loadJSON('data/features.json'),
	loadJSON('data/' + getTimetableFileName()),
	loadJSON('data/trains.json'),
	loadJSON('data/rail-directions.json'),
	loadJSON('data/train-types.json'),
	loadJSON('data/operators.json'),
	loadJSON('data/airports.json'),
	loadJSON('data/flight-status.json'),
	loadJSON('https://mini-tokyo.appspot.com/e')
]).then(function([
	dict, railwayRefData, stationRefData, railwayFeatureCollection, timetableRefData, trainData,
	railDirectionRefData, trainTypeRefData, operatorRefData, airportRefData, flightStatusRefData, e
]) {

mapboxgl.accessToken = 'pk.eyJ1IjoibmFnaXgiLCJhIjoiY2sxaTZxY2gxMDM2MDNjbW5nZ2h4aHB6ZyJ9.npSnxvMC4r5S74l8A9Hrzw';

var map = new mapboxgl.Map({
	container: 'map',
	style: 'data/osm-liberty.json',
	attributionControl: true,
	hash: true,
	center: [139.7670, 35.6814],
	zoom: 14,
	pitch: 60
});

var unit = Math.pow(2, 14 - clamp(map.getZoom(), 13, 19));

layerZoom = clamp(Math.floor(map.getZoom()), 13, 18);
altitudeUnit = Math.pow(2, 14 - layerZoom) * modelScale * 100;
objectUnit = Math.max(unit * .19, .02);
objectScale = unit * modelScale * 100;
carScale = Math.max(.02 / .19, unit) * modelScale * 100;
aircraftScale = Math.max(.06 / .285, unit) * modelScale * 100;

var trainLayers = {
	ug: new ThreeLayer('trains-ug'),
	og: new ThreeLayer('trains-og'),
	addObject: function(object, duration) {
		var layer = object.userData.altitude < 0 ? this.ug : this.og;

		object.material.opacity = 0;
		layer.scene.add(object);
		if (duration > 0) {
			startAnimation({
				callback: function(elapsed) {
					object.material.opacity = getObjectOpacity(object) * elapsed / duration;
				},
				duration: duration
			});
		}
	},
	updateObject: function(object) {
		var layer = object.userData.altitude < 0 ? this.ug : this.og;

		layer.scene.add(object);
	},
	removeObject: function(object, duration) {
		var layer;

		if (!object) {
			return;
		}
		layer = object.userData.altitude < 0 ? this.ug : this.og;
		if (duration > 0) {
			startAnimation({
				callback: function(elapsed) {
					object.material.opacity = getObjectOpacity(object) * (1 - elapsed / duration);
				},
				complete: function() {
					layer.scene.remove(object);
				},
				duration: duration
			});
		} else {
			layer.scene.remove(object);
		}
	},
	pickObject: function(point) {
		if (isUndergroundVisible) {
			return this.ug.pickObject(point) || this.og.pickObject(point);
		} else {
			return this.og.pickObject(point) || this.ug.pickObject(point);
		}
	},
	onResize: function(event) {
		this.ug.onResize(event);
		this.og.onResize(event);
	}
};

var rainLayer = new ThreeLayer('rain');

railwayLookup = buildLookup(railwayRefData);
stationLookup = buildLookup(stationRefData);

// Build feature lookup dictionary and update feature properties
turf.featureEach(railwayFeatureCollection, function(feature) {
	var id = feature.properties.id;
	if (id && !id.match(/\.(ug|og)\./)) {
		featureLookup[id] = feature;
		updateDistances(feature);
	}
});

lastTimetableRefresh = getTime('03:00');
updateTimetableRefData(timetableRefData);
trainLookup = buildLookup(timetableRefData, 't');

railDirectionLookup = buildLookup(railDirectionRefData);
trainTypeLookup = buildLookup(trainTypeRefData);
operatorLookup = buildLookup(operatorRefData);
airportLookup = buildLookup(airportRefData);
flightStatusLookup = buildLookup(flightStatusRefData);

map.once('load', function () {
	document.getElementById('loader').style.opacity = 0;
	setTimeout(function() {
		document.getElementById('loader').style.display = 'none';
	}, 1000);
});

map.once('styledata', function () {
	map.setLayoutProperty('poi', 'text-field', '{name_' + (lang === 'ja' || lang === 'ko' ? lang : lang === 'zh' ? 'zh-Hans' : 'en') + '}');

	[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
		var minzoom = zoom <= 13 ? 0 : zoom;
		var maxzoom = zoom >= 18 ? 24 : zoom + 1;
		var lineWidthScale = zoom === 13 ? clamp(Math.pow(2, map.getZoom() - 12), .125, 1) : 1;

		map.addLayer(new MapboxLayer({
			id: 'railways-ug-' + zoom,
			type: GeoJsonLayer,
			data: filterFeatures(railwayFeatureCollection, function(p) {
				return p.zoom === zoom && p.type === 0 && p.altitude < 0;
			}),
			filled: false,
			stroked: true,
			getLineWidth: function(d) {
				return d.properties.width;
			},
			getLineColor: function(d) {
				return colorToRGBArray(d.properties.color);
			},
			lineWidthUnits: 'pixels',
			lineWidthScale: lineWidthScale,
			lineJointRounded: true,
			opacity: .0625
		}), 'building-3d');
		map.setLayerZoomRange('railways-ug-' + zoom, minzoom, maxzoom);
		map.addLayer(new MapboxLayer({
			id: 'stations-ug-' + zoom,
			type: GeoJsonLayer,
			data: filterFeatures(railwayFeatureCollection, function(p) {
				return p.zoom === zoom && p.type === 1 && p.altitude < 0;
			}),
			filled: true,
			stroked: true,
			getLineWidth: 4,
			getLineColor: [0, 0, 0],
			lineWidthUnits: 'pixels',
			lineWidthScale: lineWidthScale,
			getFillColor: [255, 255, 255, 179],
			opacity: .0625
		}), 'building-3d');
		map.setLayerZoomRange('stations-ug-' + zoom, minzoom, maxzoom);
	});

	// Workaround for deck.gl #3522
	map.__deck.props.getCursor = function() {
		return map.getCanvas().style.cursor;
	};

	map.addLayer(trainLayers.ug, 'building-3d');

	[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
		var minzoom = zoom <= 13 ? 0 : zoom;
		var maxzoom = zoom >= 18 ? 24 : zoom + 1;
		var getWidth = ['get', 'width'];
		var lineWidth = zoom === 13 ?
			['interpolate', ['exponential', 2], ['zoom'], 9, ['/', getWidth, 8], 12, getWidth] : getWidth;

		map.addLayer({
			id: 'railways-og-' + zoom,
			type: 'line',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 0 && p.altitude === 0;
				})
			},
			paint: {
				'line-color': ['get', 'color'],
				'line-width': lineWidth
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
		map.addLayer({
			id: 'stations-og-' + zoom,
			type: 'fill',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 1 && p.altitude === 0;
				})
			},
			paint: {
				'fill-color': ['get', 'color'],
				'fill-opacity': .7
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
		map.addLayer({
			id: 'stations-outline-og-' + zoom,
			type: 'line',
			source: {
				type: 'geojson',
				data: filterFeatures(railwayFeatureCollection, function(p) {
					return p.zoom === zoom && p.type === 1 && p.altitude === 0;
				})
			},
			paint: {
				'line-color': ['get', 'outlineColor'],
				'line-width': lineWidth
			},
			minzoom: minzoom,
			maxzoom: maxzoom
		}, 'building-3d');
	});

	map.addLayer(trainLayers.og, 'building-3d');

	map.addLayer(rainLayer, 'poi');

	map.getStyle().layers.filter(function(layer) {
		return (layer.type === 'background' || layer.type === 'line' || layer.type.indexOf('fill') === 0) &&
			layer.id.indexOf('-og-') === -1 && layer.id.indexOf('-ug-') === -1;
	}).forEach(function(layer) {
		var id = layer.id;
		var keys = [];

		switch (layer.type) {
			case 'background':
				keys = ['background-color'];
				break;
			case 'line':
				keys = ['line-color'];
				break;
			case 'fill':
				keys = ['fill-color', 'fill-outline-color'];
				break;
			case 'fill-extrusion':
				keys = ['fill-extrusion-color'];
				break;
		}
		keys.forEach(function(key) {
			var prop = map.getPaintProperty(id, key);
			var c;

			if (typeof prop === 'string') {
				c = prop.match(/rgba\((\d+),(\d+),(\d+),([\d\.]+)\)/);
				styleColors.push({id: id, key: key, r: c[1], g: c[2], b: c[3], a: c[4]});
			} else if (typeof prop === 'object') {
				prop.stops.forEach(function(item, i) {
					c = item[1].match(/rgba\((\d+),(\d+),(\d+),([\d\.]+)\)/);
					styleColors.push({id: id, key: key, stops: i, r: c[1], g: c[2], b: c[3], a: c[4]});
				});
			}
		});
	});

	map.getStyle().layers.filter(function(layer) {
		return layer.type === 'line' || layer.type.indexOf('fill') === 0;
	}).forEach(function(layer) {
		var id = layer.id;
		var key = layer.type + '-opacity';

		styleOpacities.push({id: id, key: key, opacity: map.getPaintProperty(id, key) || 1});
	});

	var datalist = document.createElement('datalist');
	datalist.id = 'stations';
	stationTitleLookup = {};
	[lang, 'en'].forEach(function(l) {
		stationRefData.forEach(function(station) {
			var title = station.title[l];
			var coord = station.coord;
			var option;

			if (title && !stationTitleLookup[title.toUpperCase()] && coord[0] && coord[1]) {
				option = document.createElement('option');
				option.value = title;
				datalist.appendChild(option);
				stationTitleLookup[title.toUpperCase()] = station;
			}
		});
	});
	document.body.appendChild(datalist);

	var searchBox = document.getElementById('search-box');
	var searchListener = function(event) {
		var station = stationTitleLookup[event.target.value.toUpperCase()];

		if (station && station.coord) {
			trackedObject = undefined;
			popup.remove();
			stopViewAnimation();
			document.getElementsByClassName('mapbox-ctrl-track')[0].classList.remove('mapbox-ctrl-track-active');
			if (isUndergroundVisible && !(station.altitude < 0)) {
				document.getElementsByClassName('mapbox-ctrl-underground')[0]
					.dispatchEvent(new MouseEvent('click'));
			}
			if (!isUndergroundVisible && (station.altitude < 0)) {
				map.once('moveend', function() {
					document.getElementsByClassName('mapbox-ctrl-underground')[0]
						.dispatchEvent(new MouseEvent('click'));
				});
			}
			map.flyTo({
				center: station.coord,
				zoom: Math.max(map.getZoom(), 15)
			});
		}
	};
	searchBox.placeholder = dict['station-name'];
	searchBox.addEventListener(isEdge ? 'blur' : 'change', searchListener);

	// Workaround for Edge
	if (isEdge) {
		searchBox.addEventListener('keydown', function(event) {
			if (event.key === 'Enter') {
				searchListener(event);
			}
		});
	}

	var control = new MapboxGLButtonControl([{
		className: 'mapbox-ctrl-search',
		title: dict['search'],
		eventHandler: function(event) {
			if (this.style.width !== '240px') {
				this.style.width = '240px';
				searchBox.style.display = 'block';
				searchBox.value = '';
				searchBox.focus();
				setTimeout(function() {
					searchBox.style.opacity = 1;
				}, 300);
			} else {
				this.style.width = '30px';
				searchBox.style.display = 'none';
				searchBox.style.opacity = 0;
			}
		}
	}]);
	map.addControl(control);

	control = new mapboxgl.NavigationControl();
	control._zoomInButton.title = dict['zoom-in'];
	control._zoomOutButton.title = dict['zoom-out'];
	control._compass.title = dict['compass'];
	map.addControl(control);

	control = new mapboxgl.FullscreenControl();
	control._updateTitle = function() {
		mapboxgl.FullscreenControl.prototype._updateTitle.apply(this,arguments);
		this._fullscreenButton.title = dict[(this._isFullscreen() ? 'exit' : 'enter') + '-fullscreen'];
	}
	map.addControl(control);

	map.addControl(new MapboxGLButtonControl([{
		className: 'mapbox-ctrl-underground',
		title: dict['enter-underground'],
		eventHandler: function(event) {
			isUndergroundVisible = !isUndergroundVisible;
			this.title = dict[(isUndergroundVisible ? 'exit' : 'enter') + '-underground'];
			if (isUndergroundVisible) {
				this.classList.add('mapbox-ctrl-underground-visible');
				map.setPaintProperty('background', 'background-color', 'rgb(16,16,16)');
			} else {
				this.classList.remove('mapbox-ctrl-underground-visible');
				map.setPaintProperty('background', 'background-color', getStyleColor(styleColors[0], isRealtime));
			}
			styleOpacities.forEach(function(item) {
				var id = item.id;
				var opacity = item.opacity;

				if (isUndergroundVisible) {
					opacity *= id.indexOf('-og-') !== -1 ? .25 : .0625;
				}
				map.setPaintProperty(id, item.key, opacity);
			});

			startAnimation({
				callback: function(elapsed, duration) {
					var t = elapsed / duration;

					[13, 14, 15, 16, 17, 18].forEach(function(zoom) {
						var opacity = isUndergroundVisible ?
							1 * t + .0625 * (1 - t) : 1 * (1 - t) + .0625 * t;

						setLayerProps(map, 'railways-ug-' + zoom, {opacity: opacity});
						setLayerProps(map, 'stations-ug-' + zoom, {opacity: opacity});
					});
					Object.keys(activeTrainLookup).forEach(function(key) {
						var train = activeTrainLookup[key];
						var delayMarker = train.delayMarker;

						train.cars.forEach(function(car) {
							car.material.opacity = getObjectOpacity(car, t);
						});
						if (delayMarker) {
							delayMarker.material.opacity = getObjectOpacity(delayMarker, t);
						}
					});
					Object.keys(activeFlightLookup).forEach(function(key) {
						var flight = activeFlightLookup[key];

						flight.body.material.opacity = flight.wing.material.opacity = flight.vTail.material.opacity = getObjectOpacity(flight.body, t);
					});
				},
				duration: 300
			});
		}
	}, {
		className: 'mapbox-ctrl-track mapbox-ctrl-track-helicopter',
		title: dict['track'],
		eventHandler: function(event) {
			if (trackingMode === 'helicopter') {
				trackingMode = 'train';
				this.classList.remove('mapbox-ctrl-track-helicopter');
				this.classList.add('mapbox-ctrl-track-train');
			} else {
				trackingMode = 'helicopter';
				this.classList.remove('mapbox-ctrl-track-train');
				this.classList.add('mapbox-ctrl-track-helicopter');
			}
			if (trackedObject) {
				startViewAnimation();
			}
			event.stopPropagation();
		}
	}, {
		className: 'mapbox-ctrl-realtime mapbox-ctrl-realtime-active',
		title: dict['exit-realtime'],
		eventHandler: function() {
			isRealtime = !isRealtime;
			this.title = dict[(isRealtime ? 'exit' : 'enter') + '-realtime'];
			stopAllTrains();
			trackedObject = undefined;
			popup.remove();
			stopViewAnimation();
			document.getElementsByClassName('mapbox-ctrl-track')[0].classList.remove('mapbox-ctrl-track-active');
			if (isRealtime) {
				this.classList.add('mapbox-ctrl-realtime-active');
				document.getElementById('clock').style.display = 'block';
			} else {
				this.classList.remove('mapbox-ctrl-realtime-active');
				document.getElementById('clock').style.display = 'none';
				initModelTrains();
			}
			refreshStyleColors();
		}
	}, {
		className: 'mapbox-ctrl-weather',
		title: dict['show-weather'],
		eventHandler: function() {
			isWeatherVisible = !isWeatherVisible;
			this.title = dict[(isWeatherVisible ? 'hide' : 'show') + '-weather'];
			if (isWeatherVisible) {
				this.classList.add('mapbox-ctrl-weather-active');
				loadNowCastData();
			} else {
				this.classList.remove('mapbox-ctrl-weather-active');
				if (fgGroup) {
					rainLayer.scene.remove(fgGroup.mesh);
	//				fgGroup.dispose();
					imGroup = undefined;
				}
			}
		}
	}]), 'top-right');

	var aboutPopup = new mapboxgl.Popup({
		closeButton: false,
		closeOnClick: false,
		anchor: 'right',
		maxWidth: '300px'
	});

	map.addControl(new MapboxGLButtonControl([{
		className: 'mapbox-ctrl-about',
		title: dict['about'],
		eventHandler: function() {
			if (!aboutPopup.isOpen()) {
				updateAboutPopup();
				aboutPopup.addTo(map);
			} else {
				aboutPopup.remove();
			}
		}
	}]));

	document.getElementById('clock').style.display = 'block';

	var popup = new mapboxgl.Popup({
		closeButton: false,
		closeOnClick: false,
		offset: {
			top: [0, 10],
			bottom: [0, -30]
		}
	});

	map.on('mousemove', function(e) {
		var userData;

		if (isRealtime) {
			markedObject = trainLayers.pickObject(e.point);
			if (markedObject) {
				map.getCanvas().style.cursor = 'pointer';
				userData = markedObject.userData;
				popup.setLngLat(adjustCoord(userData.coord, userData.altitude))
					.setHTML(userData.object.description)
					.addTo(map);
			} else if (popup.isOpen()) {
				map.getCanvas().style.cursor = '';
				popup.remove();
			}
		}
	});

	map.on('click', function(e) {
		stopViewAnimation();
		trackedObject = trainLayers.pickObject(e.point);
		if (trackedObject) {
			startViewAnimation();
			document.getElementsByClassName('mapbox-ctrl-track')[0]
				.classList.add('mapbox-ctrl-track-active');
			if (isUndergroundVisible !== (trackedObject.userData.altitude < 0)) {
				document.getElementsByClassName('mapbox-ctrl-underground')[0]
					.dispatchEvent(new MouseEvent('click'));
			}
		} else {
			document.getElementsByClassName('mapbox-ctrl-track')[0]
				.classList.remove('mapbox-ctrl-track-active');
		}

		/* For development
		console.log(e.lngLat);
		*/
	});

	map.on('zoom', function() {
		if (trackedObject) {
			altitude = trackedObject.userData.altitude;
			// Keep camera off from the tracked aircraft
			if (altitude > 0 && Math.pow(2, 22 - map.getZoom()) / altitude < .5) {
				map.setZoom(22 - Math.log2(altitude * .5));
			}
		}

		var zoom = map.getZoom();
		var unit = Math.pow(2, 14 - clamp(zoom, 13, 19));
		var lineWidthScale = clamp(Math.pow(2, zoom - 12), .125, 1);

		setLayerProps(map, 'railways-ug-13', {lineWidthScale: lineWidthScale});
		setLayerProps(map, 'stations-ug-13', {lineWidthScale: lineWidthScale});

		layerZoom = clamp(Math.floor(zoom), 13, 18);
		altitudeUnit = Math.pow(2, 14 - layerZoom) * modelScale * 100;
		objectUnit = Math.max(unit * .19, .02);
		objectScale = unit * modelScale * 100;
		carScale = Math.max(.02 / .19, unit) * modelScale * 100;
		aircraftScale = Math.max(.06 / .285, unit) * modelScale * 100;

		Object.keys(activeTrainLookup).forEach(function(key) {
			var train = activeTrainLookup[key];

			updateTrainProps(train);
			updateTrainShape(train);
		});
		Object.keys(activeFlightLookup).forEach(function(key) {
			updateFlightShape(activeFlightLookup[key]);
		});
	});

	map.on('move', function() {
		if (isWeatherVisible) {
			updateEmitterQueue();
		}
		if (aboutPopup.isOpen()) {
			updateAboutPopup();
		}
	});

	map.on('resize', function(e) {
		trainLayers.onResize(e);
	});

	repeat();

	if (!isRealtime) {
		initModelTrains();
	}

	a = e[0];

	startAnimation({
		callback: function() {
			var now = Date.now();
			var userData, altitude, bearing;

			if (now - lastTimetableRefresh >= 86400000) {
				loadTimetableData();
				lastTimetableRefresh = getTime('03:00');
			}
			if (isRealtime) {
				if (Math.floor(now / 1000) !== Math.floor(lastFrameRefresh / 1000)) {
					var date = getJSTDate();
					var dateString = date.toLocaleDateString(lang, {
						year: 'numeric',
						month: 'short',
						day: 'numeric',
						weekday: 'short'
					});
					if (lang === 'ja' && JapaneseHolidays.isHoliday(date)) {
						dateString = dateString.replace(/\(.+\)/, '(祝)');
					}
					document.getElementById('date').innerHTML = dateString;
					document.getElementById('time').innerHTML = date.toLocaleTimeString(lang);
				}

				// Remove all trains if the page has been invisible for more than ten seconds
				if (now - lastFrameRefresh >= 10000) {
					stopAllTrains();
				}
				lastFrameRefresh = now;

				if (Math.floor((now - MIN_DELAY) / TRAIN_REFRESH_INTERVAL) !== Math.floor(lastTrainRefresh / TRAIN_REFRESH_INTERVAL)) {
					refreshTrains();
					refreshFlights();
					loadRealtimeTrainData();
					loadRealtimeFlightData();
					refreshStyleColors();
					lastTrainRefresh = now - MIN_DELAY;
				}
				if (markedObject) {
					userData = markedObject.userData;
					popup.setLngLat(adjustCoord(userData.coord, userData.altitude))
						.setHTML(userData.object.description);
				}
			}
			if (trackedObject) {
				altitude = trackedObject.userData.altitude;
				// Keep camera off from the tracked aircraft
				if (altitude > 0 && Math.pow(2, 22 - map.getZoom()) / altitude < .5) {
					map.setZoom(22 - Math.log2(altitude * .5));
				}
			}
			if (trackedObject && !viewAnimationID) {
				userData = trackedObject.userData;
				bearing = map.getBearing();
				map.easeTo({
					center: adjustCoord(userData.coord, userData.altitude),
					bearing: trackingMode === 'helicopter' ?
						(trackingBaseBearing + performance.now() / 100) % 360 :
						bearing + ((userData.bearing - bearing + 540) % 360 - 180) * .02,
					duration: 0
				});
			}
			if (isWeatherVisible) {
				if (now - (lastNowCastRefresh || 0) >= 60000) {
					loadNowCastData();
					lastNowCastRefresh = now;
				}
				refreshEmitter();
			}
		}
	});

	function updateTrainProps(train) {
		var feature = train.railwayFeature = featureLookup[train.r + '.' + layerZoom];
		var stationOffsets = feature.properties['station-offsets'];
		var sectionIndex = train.sectionIndex;
		var offset = train.offset = stationOffsets[sectionIndex];

		train.interval = stationOffsets[sectionIndex + train.sectionLength] - offset;
	}

	function updateTrainShape(train, t) {
		var feature = train.railwayFeature;
		var offset = train.offset;
		var cars = train.cars;
		var length = cars.length;
		var carComposition = clamp(Math.floor(train.carComposition * .02 / objectUnit), 1, train.carComposition);
		var compositionChanged = length !== carComposition;
		var delayMarker = train.delayMarker;
		var i, ilen, railway, car, position, scale, userData, pArr, p, coord, bearing, mCoord, altitudeChanged, animation, bounds;

		if (t !== undefined) {
			train._t = t;
		}
		if (train._t === undefined) {
			return;
		}

		for (i = length - 1; i >= carComposition; i--) {
			trainLayers.removeObject(cars.pop());
		}
		for (i = length; i < carComposition; i++) {
			railway = railway || railwayLookup[train.r];
			car = createCube(.88, 1.76, .88, railway.color);
			car.rotation.order = 'ZYX';
			userData = car.userData;
			userData.object = train;
			cars.push(car);
		}
		if (compositionChanged) {
			if (markedObject && markedObject.userData.object === train) {
				markedObject = cars[Math.floor(carComposition / 2)];
			}
			if (trackedObject && trackedObject.userData.object === train) {
				trackedObject = cars[Math.floor(carComposition / 2)];
			}
		}

		pArr = getCoordAndBearing(feature, offset + train._t * train.interval, carComposition, objectUnit);
		for (i = 0, ilen = cars.length; i < ilen; i++) {
			car = cars[i];
			position = car.position;
			scale = car.scale;
			userData = car.userData;

			p = pArr[i];
			coord = userData.coord = p.coord;
			altitudeChanged = (userData.altitude < 0 && p.altitude >= 0) || (userData.altitude >= 0 && p.altitude < 0);
			userData.altitude = p.altitude;
			bearing = userData.bearing = p.bearing + (train.direction < 0 ? 180 : 0);
			mCoord = mapboxgl.MercatorCoordinate.fromLngLat(coord);

			animation = animations[train.animationID];
			if (animation) {
				bounds = map.getBounds();
				if (coord[0] >= bounds.getWest() - .005 &&
					coord[0] <= bounds.getEast() + .005 &&
					coord[1] >= bounds.getSouth() - .005 &&
					coord[1] <= bounds.getNorth() + .005) {
					delete animation.frameRate;
				} else {
					animation.frameRate = 1;
				}
			}

			position.x = mCoord.x - modelOrigin.x;
			position.y = -(mCoord.y - modelOrigin.y);
			position.z = p.altitude * modelScale + objectScale / 2;
			scale.x = scale.z = objectScale;
			scale.y = carScale;
			car.rotation.x = p.pitch * train.direction;
			car.rotation.z = -bearing * DEGREE_TO_RADIAN;

			if (!car.parent) {
				trainLayers.addObject(car, 1000);
			}
			if (altitudeChanged) {
				trainLayers.updateObject(car);
				startAnimation({
					callback: function(elapsed, duration, object) {
						object.material.opacity = getObjectOpacity(object, elapsed / duration);
					},
					duration: 1000,
					userData: car
				});
				if (trackedObject === car) {
					document.getElementsByClassName('mapbox-ctrl-underground')[0]
						.dispatchEvent(new MouseEvent('click'));
				}
			}
		}

		if (train.delay) {
			if (!delayMarker) {
				delayMarker = train.delayMarker = createDelayMarker();
			}

			car = cars[Math.floor(carComposition / 2)];
			userData = delayMarker.userData;
			altitudeChanged = (userData.altitude < 0 && car.userData.altitude >= 0) || (userData.altitude >= 0 && car.userData.altitude < 0);
			userData.altitude = car.userData.altitude;
			merge(delayMarker.position, car.position);
			scale = delayMarker.scale;
			scale.x = scale.y = scale.z = carScale;

			if (!delayMarker.parent) {
				trainLayers.addObject(delayMarker, 1000);
			}
			if (altitudeChanged) {
				trainLayers.updateObject(delayMarker);
				startAnimation({
					callback: function(elapsed, duration, object) {
						object.material.opacity = getObjectOpacity(object, elapsed / duration);
					},
					duration: 1000,
					userData: delayMarker
				});
			}
		} else if (delayMarker) {
			trainLayers.removeObject(delayMarker);
			delete train.delayMarker;
		}
	}

	function updateFlightShape(flight, t) {
		var body = flight.body;
		var wing = flight.wing;
		var vTail = flight.vTail;
		var operator, p, coord, bearing, mCoord;

		if (t !== undefined) {
			flight._t = t;
		}
		if (flight._t === undefined) {
			return;
		}
		if (!body) {
			operator = operatorLookup[flight.a];
			body = flight.body = createCube(.88, 2.64, .88, operator.color || '#FFFFFF');
			wing = flight.wing = createCube(2.64, .88, .1, operator.color || '#FFFFFF');
			vTail = flight.vTail = createCube(.1, .88, .88, operator.tailcolor || '#FFFFFF');
			vTail.geometry.translate(0, -.88, .88);
			body.rotation.order = wing.rotation.order = vTail.rotation.order = 'ZYX';
			body.userData.object = wing.userData.object = vTail.userData.object = flight;
			trainLayers.addObject(body, 1000);
			trainLayers.addObject(wing, 1000);
			trainLayers.addObject(vTail, 1000);
		}

		p = getCoordAndBearing(flight.feature, flight._t * flight.feature.properties.length, 1, 0)[0];

		coord = body.userData.coord = wing.userData.coord = vTail.userData.coord = p.coord;
		body.userData.altitude = wing.userData.altitude = vTail.userData.altitude = p.altitude;
		bearing = body.userData.bearing = wing.userData.bearing = vTail.userData.bearing = p.bearing;
		mCoord = mapboxgl.MercatorCoordinate.fromLngLat(coord);

		animation = animations[flight.animationID];
		if (animation) {
			bounds = map.getBounds();
			if (coord[0] >= bounds.getWest() - .005 &&
				coord[0] <= bounds.getEast() + .005 &&
				coord[1] >= bounds.getSouth() - .005 &&
				coord[1] <= bounds.getNorth() + .005) {
				delete animation.frameRate;
			} else {
				animation.frameRate = 1;
			}
		}

		position = body.position;
		position.x = mCoord.x - modelOrigin.x;
		position.y = -(mCoord.y - modelOrigin.y);
		position.z = p.altitude * modelScale + objectScale / 2;
		scale = body.scale;
		scale.x = scale.z = objectScale;
		scale.y = aircraftScale;
		body.rotation.x = p.pitch;
		body.rotation.z = -bearing * DEGREE_TO_RADIAN;

		merge(wing.position, body.position);
		scale = wing.scale;
		scale.x = aircraftScale;
		scale.y = scale.z = objectScale;
		wing.rotation.x = body.rotation.x;
		wing.rotation.z = body.rotation.z;

		merge(vTail.position, body.position);
		scale = vTail.scale
		scale.x = scale.z = objectScale;
		scale.y = aircraftScale;
		vTail.rotation.x = body.rotation.x;
		vTail.rotation.z = body.rotation.z;
	}

	function initModelTrains() {
		trainData.forEach(function(train, i) {
			var railway = railwayLookup[train.r];

			train.t = i;
			activeTrainLookup[train.t] = train;

			train.sectionLength = train.direction;
			train.carComposition = railway.carComposition;
			train.cars = [];
			updateTrainProps(train);

			function repeat() {
				train.animationID = startTrainAnimation(function(t) {
					updateTrainShape(train, t);
				}, function() {
					var direction = train.direction;
					var sectionIndex = train.sectionIndex = train.sectionIndex + direction;

					if (sectionIndex <= 0 || sectionIndex >= railway.stations.length - 1) {
						train.direction = train.sectionLength = -direction;
					}
					updateTrainProps(train);
					updateTrainShape(train, 0);

					// Stop and go
					train.animationID = startAnimation({complete: repeat, duration: 1000});
				}, Math.abs(train.interval), TIME_FACTOR);
			}
			repeat();
		});
	}

	function refreshTrains() {
		var now = Date.now();

		timetableRefData.forEach(function(train) {
			var d = train.delay || 0;
			if (train.start + d <= now && now <= train.end + d &&
				!activeTrainLookup[train.t] &&
				(!train.previousTrain || !activeTrainLookup[train.previousTrain.t]) &&
				(!train.nextTrain || !activeTrainLookup[train.nextTrain.t]) &&
				(!railwayLookup[train.r].status || realtimeTrainLookup[train.t])) {
				function start(index) {
					var now = Date.now();
					var departureTime;

					if (!setSectionData(train, index)) {
						return; // Out of range
					}
					activeTrainLookup[train.t] = train;
					train.cars = [];
					departureTime = getTime(train.departureTime) + (train.delay || 0);
					if (now >= departureTime) {
						updateTrainProps(train);
						repeat(now - departureTime);
					} else {
						stand();
					}
				}

				function stand(final) {
					var departureTime = getTime(train.departureTime) + (train.delay || 0);

					if (!final) {
						updateTrainProps(train);
						updateTrainShape(train, 0);
					}
					setTrainStandingStatus(train, true);
					train.animationID = startAnimation({
						complete: !final ? repeat : function() {
							stopTrain(train);
						},
						duration: Math.max(departureTime - Date.now(), MIN_STANDING_DURATION)
					});
				}

				function repeat(elapsed) {
					setTrainStandingStatus(train, false);
					train.animationID = startTrainAnimation(function(t) {
						updateTrainShape(train, t);
					}, function() {
						var markedObjectIndex, trackedObjectIndex;

						if (!setSectionData(train, train.timetableIndex + 1)) {
							markedObjectIndex = train.cars.indexOf(markedObject);
							trackedObjectIndex = train.cars.indexOf(trackedObject);
							if (train.nextTrain) {
								stopTrain(train);
								train = train.nextTrain;
								if (!activeTrainLookup[train.t]) {
									start(0);
									if (train.cars) {
										if (markedObjectIndex !== -1) {
											markedObject = train.cars[markedObjectIndex];
										}
										if (trackedObjectIndex !== -1) {
											trackedObject = train.cars[trackedObjectIndex];
										}
									}
								}
								return;
							}
							stand(true);
						} else {
							stand();
						}
					}, Math.abs(train.interval), 1, elapsed);
				}

				start();
			}
		});
	}

	function refreshFlights() {
		var now = Date.now();

		Object.keys(flightLookup).forEach(function(key) {
			var flight = flightLookup[key];

			if (flight.standing <= now && now <= flight.end && !activeFlightLookup[flight.id]) {
				activeFlightLookup[flight.id] = flight;
				if (now >= flight.start) {
					repeat(now - flight.start);
				} else {
					updateFlightShape(flight, 0);
					setFlightStandingStatus(flight, true);
					flight.animationID = startAnimation({
						complete: repeat,
						duration: flight.start - now
					});
				}

				function repeat(elapsed) {
					setFlightStandingStatus(flight, false);
					flight.animationID = startFlightAnimation(function(t) {
						updateFlightShape(flight, t);
					}, function() {
						setFlightStandingStatus(flight, true);
						flight.animationID = startAnimation({
							complete: function() {
								stopFlight(flight);
							},
							duration: Math.max(flight.end - Date.now(), 0)
						});
					}, flight.feature.properties.length, flight.maxSpeed, flight.acceleration, elapsed);
				}
			}
		});
	}

	function startViewAnimation() {
		var t2 = 0;

		trackingBaseBearing = map.getBearing() - performance.now() / 100;
		viewAnimationID = startAnimation({
			callback: function(elapsed, duration) {
				var t1 = easeOutQuart(elapsed / duration);
				var factor = (1 - t1) / (1 - t2);
				var userData = trackedObject.userData;
				var coord = adjustCoord(userData.coord, userData.altitude);
				var lng = coord[0];
				var lat = coord[1];
				var center = map.getCenter();
				var bearing = userData.bearing;

				map.easeTo({
					center: [lng - (lng - center.lng) * factor, lat - (lat - center.lat) * factor],
					bearing: trackingMode === 'helicopter' ?
						(trackingBaseBearing + performance.now() / 100) % 360 :
						bearing - ((bearing - map.getBearing() + 540) % 360 - 180) * factor,
					duration: 0
				});
				t2 = t1;
			},
			complete: function() {
				viewAnimationID = undefined;
			},
			duration: 1000
		});
	}

	function stopViewAnimation() {
		if (viewAnimationID) {
			stopAnimation(viewAnimationID);
			viewAnimationID = undefined;
		}
	}

	function adjustCoord(coord, altitude) {
		var mCoord, pos, world;

		if (!altitude) {
			return coord;
		}
		mCoord = mapboxgl.MercatorCoordinate.fromLngLat(coord);
		pos = new THREE.Vector3(mCoord.x - modelOrigin.x, -(mCoord.y - modelOrigin.y), altitude * modelScale).project(trainLayers.ug.camera);
		world = map.unproject([(pos.x + 1) / 2 * map.transform.width, (1 - pos.y) / 2 * map.transform.height]);
		return [world.lng, world.lat];
	}

	function getLocalizedRailwayTitle(railway) {
		title = (railwayLookup[railway] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedRailDirectionTitle(direction) {
		title = (railDirectionLookup[direction] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedTrainTypeTitle(type) {
		title = (trainTypeLookup[type] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedStationTitle(station) {
		station = Array.isArray(station) ? station[0] : station;
		title = (stationLookup[station] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedOperatorTitle(operator) {
		title = (operatorLookup[operator] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedAirportTitle(airport) {
		title = (airportLookup[airport] || {}).title || {};
		return title[lang] || title['en'];
	}

	function getLocalizedFlightStatusTitle(status) {
		title = (flightStatusLookup[status] || {}).title || {};
		return title[lang] || title['en'];
	}

	function setTrainStandingStatus(train, standing) {
		var railwayID = train.r;
		var railway = railwayLookup[railwayID];
		var destination = train.ds;
		var delay = train.delay || 0;

		train.standing = standing;
		train.description =
			'<span class="desc-box" style="background-color: ' + railway.color + ';"></span> ' +
			'<strong>' + getLocalizedRailwayTitle(railwayID) + '</strong>' +
			'<br>' + getLocalizedTrainTypeTitle(train.y) + ' ' +
			(destination ? dict['for'].replace('$1', getLocalizedStationTitle(destination)) : getLocalizedRailDirectionTitle(train.d)) +
			'<br><strong>' + dict['train-number'] + ':</strong> ' + train.n +
			'<br>' + (delay >= 60000 ? '<span class="desc-caution">' : '') +
			'<strong>' + dict[train.standing ? 'standing-at' : 'previous-stop'] + ':</strong> ' +
			getLocalizedStationTitle(train.departureStation) +
			' ' + getTimeString(getTime(train.departureTime) + delay) +
			(train.arrivalStation ?
				'<br><strong>' + dict['next-stop'] + ':</strong> ' +
				getLocalizedStationTitle(train.arrivalStation) +
				' ' + getTimeString(getTime(train.arrivalTime) + delay) : '') +
			(delay >= 60000 ? '<br>' + dict['delay'].replace('$1', Math.floor(delay / 60000)) + '</span>' : '') +
			(railway.status && lang === 'ja' ? '<br><span class="desc-caution"><strong>' + railway.status + ':</strong> ' + railway.text + '</span>' : '');
	}

	function setFlightStandingStatus(flight, standing) {
		var airlineID = flight.a;
		var flightNumber = flight.n;
		var destination = flight.ds;
		var origin = flight.or;
		var scheduledTime = flight.sdt || flight.sat;
		var estimatedTime = flight.edt || flight.eat;
		var actualTime = flight.adt || flight.aat;
		var delayed = (estimatedTime || actualTime) && scheduledTime !== (estimatedTime || actualTime);

		flight.description =
			'<span class="desc-box" style="background-color: ' + (operatorLookup[airlineID].tailcolor || '#FFFFFF') + ';"></span> ' +
			'<strong>' + getLocalizedOperatorTitle(airlineID) + '</strong>' +
			'<br>' + flightNumber[0] + ' ' +
			dict[destination ? 'to' : 'from'].replace('$1', getLocalizedAirportTitle(destination || origin)) +
			'<br><strong>' + dict['status'] + ':</strong> ' + getLocalizedFlightStatusTitle(flight.s) +
			'<br><strong>' + dict['scheduled-' + (destination ? 'departure' : 'arrival') + '-time'] + ':</strong> ' + scheduledTime +
			(delayed ? '<span class="desc-caution">' : '') +
			(estimatedTime || actualTime ? '<br><strong>' + (estimatedTime ?
				dict['estimated-' + (destination ? 'departure' : 'arrival') + '-time'] + ':</strong> ' + estimatedTime :
				dict['actual-' + (destination ? 'departure' : 'arrival') + '-time'] + ':</strong> ' + actualTime) : '') +
			(delayed ? '</span>' : '') +
			(flightNumber.length > 1 ? '<br><strong>' + dict['code-share'] + ':</strong> ' + flightNumber.slice(1).join(' ') : '');
	}

	function stopTrain(train) {
		stopAnimation(train.animationID);
		if (train.cars) {
			train.cars.forEach(function(car) {
				trainLayers.removeObject(car, 1000);
			});
		}
		delete train.cars;
		delete activeTrainLookup[train.t];
		if (train.delayMarker) {
			trainLayers.removeObject(train.delayMarker, 1000);
			delete train.delayMarker;
		}
	}

	function stopFlight(flight) {
		stopAnimation(flight.animationID);
		trainLayers.removeObject(flight.body, 1000);
		trainLayers.removeObject(flight.wing, 1000);
		trainLayers.removeObject(flight.vTail, 1000);
		delete flight.body;
		delete flight.wing;
		delete flight.vTail;
		delete activeFlightLookup[flight.id];
	}

	function stopAllTrains() {
		Object.keys(activeTrainLookup).forEach(function(key) {
			stopTrain(activeTrainLookup[key]);
		});
		Object.keys(activeFlightLookup).forEach(function(key) {
			stopFlight(activeFlightLookup[key]);
		});
		lastTrainRefresh = undefined;
	}

	function adjustTrainID(id, type) {
		if (type === 'JR-East.Rapid' || type === 'JR-East.LimitedExpress') {
			return id.replace(/JR-East\.(NaritaAirportBranch|Narita|Sobu)/, 'JR-East.SobuRapid');
		}
		return id;
	}

	function loadTimetableData() {
		loadJSON('data/' + getTimetableFileName()).then(function(data) {
			timetableRefData = data;
			updateTimetableRefData(timetableRefData);
			trainLookup = buildLookup(timetableRefData, 't');
		});
	}

	function loadRealtimeTrainData() {
		Promise.all([
			loadJSON(API_URL + 'odpt:TrainInformation?odpt:operator=odpt.Operator:JR-East,odpt.Operator:TWR,odpt.Operator:TokyoMetro,odpt.Operator:Toei,odpt.Operator:YokohamaMunicipal,odpt.Operator:Keio'),
			loadJSON(API_URL + 'odpt:Train?odpt:operator=odpt.Operator:JR-East,odpt.Operator:TokyoMetro,odpt.Operator:Toei')
		]).then(function([trainInfoRefData, trainRefData]) {
			realtimeTrainLookup = {};

			trainRefData.forEach(function(trainRef) {
				var delay = trainRef['odpt:delay'] * 1000;
				var carComposition = trainRef['odpt:carComposition'];
				var trainType = removePrefix(trainRef['odpt:trainType']);
				var destination = removePrefix(trainRef['odpt:destinationStation']);
				var id = adjustTrainID(removePrefix(trainRef['owl:sameAs']));
				var train = trainLookup[id];
				var activeTrain = activeTrainLookup[id];
				var changed = false;

				if (train) {
					realtimeTrainLookup[id] = train;
					if (delay && train.delay !== delay) {
						train.delay = delay;
						changed = true;
					}
					if (carComposition && train.carComposition !== carComposition) {
						train.carComposition = carComposition;
						changed = true;
					}
					if (trainType && train.y !== trainType) {
						train.y = trainType;
						changed = true;
					}
					if (train.ds && destination && train.ds[0] !== destination[0]) {
						train.ds = destination;
						changed = true;
					}
					if (changed && activeTrainLookup[id]) {
						stopTrain(train);
					}
				}
				lastDynamicUpdate[removePrefix(trainRef['odpt:operator'])] = trainRef['dc:date'].replace(/([\d\-])T([\d:]+).*/, '$1 $2');
			});

			// Reset railway information text
			railwayRefData.forEach(function(railway) {
				delete railway.status;
				delete railway.text;
			});

			trainInfoRefData.forEach(function(trainInfoRef) {
				var operatorID = removePrefix(trainInfoRef['odpt:operator']);
				var railwayID = removePrefix(trainInfoRef['odpt:railway']);
				var status = trainInfoRef['odpt:trainInformationStatus'];
				var text = trainInfoRef['odpt:trainInformationText'];

				// Train information text is provided in Japanese only
				if (railwayID && status && status.ja &&
					(operatorID === 'JR-East' || operatorID === 'TokyoMetro' || operatorID === 'Toei') &&
					(status.ja.indexOf('見合わせ') !== -1 ||
					status.ja.indexOf('折返し運転') !== -1 ||
					status.ja.indexOf('運休') !== -1 ||
					status.ja.indexOf('遅延') !== -1)) {
					railway = railwayLookup[railwayID];
					railway.status = status.ja;
					railway.text = text.ja;
					Object.keys(activeTrainLookup).forEach(function(key) {
						var train = activeTrainLookup[key];
						if (train.r === railwayID && !realtimeTrainLookup[train.t]) {
							stopTrain(train);
						}
					});
				}
			});

			refreshTrains();
			updateAboutPopup();
		});
	}

	function loadRealtimeFlightData() {
		Promise.all([
			loadJSON(API_URL + 'odpt:FlightInformationArrival?odpt:operator=odpt.Operator:NAA,odpt.Operator:HND-JAT,odpt.Operator:HND-TIAT'),
			loadJSON(API_URL + 'odpt:FlightInformationDeparture?odpt:operator=odpt.Operator:NAA,odpt.Operator:HND-JAT,odpt.Operator:HND-TIAT')
		]).then(function(flightRefData) {
			var flightQueue = {};

			concat(flightRefData).forEach(function(flightRef) {
				var id = removePrefix(flightRef['owl:sameAs']);
				var flight = flightLookup[id];
				var status = removePrefix(flightRef['odpt:flightStatus']);
				var maxSpeed = MAX_FLIGHT_SPEED;
				var acceleration = FLIGHT_ACCELERATION;
				var departureAirport, arrivalAirport, destinationAirport, originAirport, direction, runway, feature, departureTime, arrivalTime, duration;

				if (!flight) {
					if (status === 'Cancelled') {
						return;
					}
					departureAirport = removePrefix(flightRef['odpt:departureAirport']);
					arrivalAirport = removePrefix(flightRef['odpt:arrivalAirport']);
					destinationAirport = removePrefix(flightRef['odpt:destinationAirport']);
					originAirport = removePrefix(flightRef['odpt:originAirport']);
					direction = airportLookup[destinationAirport || originAirport].direction;
					runway = departureAirport === 'NRT' ? departureAirport + '.34L' :
						arrivalAirport === 'NRT' ? arrivalAirport + '.34R' :
						departureAirport === 'HND' && direction === 'S' ? departureAirport + '.05' :
						departureAirport === 'HND' && direction === 'N' ? departureAirport + '.34R' :
						arrivalAirport === 'HND' && direction === 'S' ? arrivalAirport + '.34L' :
						arrivalAirport === 'HND' && direction === 'N' ? arrivalAirport + '.34R' : undefined;
					feature = featureLookup[runway + (departureAirport ? '.Dep' : '.Arr')];
					if (feature) {
						flight = flightLookup[id] = {
							id: id,
							n: flightRef['odpt:flightNumber'],
							a: removePrefix(flightRef['odpt:airline']),
							dp: departureAirport,
							ar: arrivalAirport,
							ds: destinationAirport,
							or: originAirport,
							runway: runway,
							feature: feature
						};
					} else {
						return;
					}
				}
				merge(flight, {
					edt: flightRef['odpt:estimatedDepartureTime'],
					adt: flightRef['odpt:actualDepartureTime'],
					sdt: flightRef['odpt:scheduledDepartureTime'],
					eat: flightRef['odpt:estimatedArrivalTime'],
					aat: flightRef['odpt:actualArrivalTime'],
					sat: flightRef['odpt:scheduledArrivalTime']
				});

				departureTime = flight.edt || flight.adt || flight.sdt;
				arrivalTime = flight.eat || flight.aat || flight.sat;

				if (!status) {
					if (arrivalTime < flight.sat) {
						status = 'NewTime';
					} else if (arrivalTime > flight.sat) {
						status = 'Delayed';
					} else if (arrivalTime === flight.sat) {
						status = 'OnTime';
					}
				} else if (status === 'CheckIn' || status === 'NowBoarding' || status === 'BoardingComplete' || status === 'Departed') {
					if (departureTime < flight.sdt) {
						status = 'NewTime';
					} else if (departureTime > flight.sdt) {
						status = 'Delayed';
					} else if (departureTime === flight.sdt) {
						status = 'OnTime';
					}
				}
				flight.s = status;

				if (arrivalTime) {
					maxSpeed /= 2;
					acceleration /= -2;
				}

				duration = maxSpeed / Math.abs(acceleration) / 2 + flight.feature.properties.length / maxSpeed;

				if (departureTime) {
					flight.start = flight.base = getTime(departureTime);
					flight.standing = flight.start - STANDING_DURATION;
					flight.end = flight.start + duration;
				} else {
					flight.start = flight.standing = getTime(arrivalTime) - duration;
					flight.base = flight.start + duration - STANDING_DURATION;
					flight.end = flight.start + duration + STANDING_DURATION;
				}
				flight.maxSpeed = maxSpeed;
				flight.acceleration = acceleration;

				queue = flightQueue[flight.runway] = flightQueue[flight.runway] || [];
				queue.push(flight);

				lastDynamicUpdate[removePrefix(flightRef['odpt:operator'])] = flightRef['dc:date'].replace(/([\d\-])T([\d:]+).*/, '$1 $2');
			});

			Object.keys(flightQueue).forEach(function(key) {
				var queue = flightQueue[key];
				var latest = 0;

				queue.sort(function(a, b) {
					return a.base - b.base;
				});
				queue.forEach(function(flight) {
					var delay = Math.max(flight.base, latest + MIN_FLIGHT_INTERVAL) - flight.base;

					if (delay) {
						flight.start += delay;
						flight.base += delay;
						flight.standing += delay;
						flight.end += delay;
					}
					latest = flight.base;
				});
			});

			refreshFlights();
		});
	}

	function loadNowCastData() {
		loadJSON('https://mini-tokyo.appspot.com/nowcast').then(function(data) {
			nowCastData = data;
			emitterBounds = {};
			updateEmitterQueue();
		});
	}

	function updateEmitterQueue() {
		var bounds = map.getBounds();
		var ne = mapboxgl.MercatorCoordinate.fromLngLat(bounds.getNorthEast());
		var sw = mapboxgl.MercatorCoordinate.fromLngLat(bounds.getSouthWest());
		var resolution = clamp(Math.pow(2, Math.floor(17 - map.getZoom())), 0, 1) * 1088;
		var currBounds = {
			left: Math.floor(clamp((sw.x - modelOrigin.x) / modelScale + 50000, 0, 108800) / resolution) * resolution,
			right: Math.ceil(clamp((ne.x - modelOrigin.x) / modelScale + 50000, 0, 108800) / resolution) * resolution,
			top: Math.floor(clamp((ne.y - modelOrigin.y) / modelScale + 42500 + 0, 0, 78336) / resolution) * resolution,
			bottom: Math.ceil(clamp((sw.y - modelOrigin.y) / modelScale + 42500 + 0, 0, 78336) / resolution) * resolution
		};

		if (currBounds.left !== emitterBounds.left ||
			currBounds.right !== emitterBounds.right ||
			currBounds.top !== emitterBounds.top ||
			currBounds.bottom !== emitterBounds.bottom) {
			bgGroup = new SPE.Group({
				texture: {
					value: rainTexture
				},
				blending: THREE.NormalBlending,
				transparent: true,
				maxParticleCount: 100000
			});
			emitterQueue = [];
			for (var y = currBounds.top; y < currBounds.bottom; y += resolution) {
				for (var x = currBounds.left; x < currBounds.right; x += resolution) {
					emitterQueue.push({
						index: {
							x: Math.floor(x / 1088),
							y: Math.floor(y / 1088)
						},
						rect: {
							x: x,
							y: y,
							w: resolution,
							h: resolution
						}
					});
				}
			}
		}
		emitterBounds = currBounds;
	}

	function refreshEmitter() {
		if (bgGroup) {
			var zoom = map.getZoom();
			var n = clamp(Math.floor(Math.pow(3, zoom - 13)), 3, 10000000);
			var h = clamp(Math.pow(2, 14 - zoom), 0, 1) * 1000;
			var v = clamp(Math.pow(1.7, 14 - zoom), 0, 1) * 2000;
			var s = clamp(Math.pow(1.2, zoom - 14.5) * map.transform.cameraToCenterDistance / 800, 0, 1);
			var emitterCount = 30;
			while (emitterCount > 0) {
				var e = emitterQueue.shift();
				if (!e) {
					imGroup = bgGroup;
					bgGroup = undefined;
					timeoutID = setTimeout(function() {
						if (imGroup) {
							if (fgGroup) {
								rainLayer.scene.remove(fgGroup.mesh);
//									fgGroup.dispose();
							}
							fgGroup = imGroup;
							imGroup = undefined;
							rainLayer.scene.add(fgGroup.mesh);
						}
					}, 500);
					break;
				}
				if (!nowCastData || !nowCastData[e.index.y][e.index.x]) {
					continue;
				}
				n = zoom >= 17 ? 20 : n;
				var emitter = new SPE.Emitter({
					maxAge: {
						value: h / v
					},
					position: {
						value: new THREE.Vector3((e.rect.x - 50000 + e.rect.w / 2) * modelScale, (42500 - e.rect.h / 2 - e.rect.y) * modelScale, h * modelScale),
						spread: new THREE.Vector3(e.rect.w * modelScale, e.rect.h * modelScale, 0)
					},
					acceleration: {
						value: new THREE.Vector3(0, 0, 0),
						spread: new THREE.Vector3(v / 20 * modelScale, 0, 0)
					},
					velocity: {
						value: new THREE.Vector3(0, 0, -v * modelScale),
						spread: new THREE.Vector3(v / 200 * modelScale, v / 200 * modelScale)
					},
					color: {
						value: new THREE.Color('blue')
					},
					size: {
						value: .000001 / modelScale * s
					},
					particleCount: Math.pow(nowCastData[e.index.y][e.index.x], 2) * n
				});
				bgGroup.addEmitter(emitter);
				emitterCount--;
			}
		}
		if (fgGroup) {
			fgGroup.tick();
		}
		if (imGroup) {
			imGroup.tick();
		}
	}

	function refreshStyleColors() {
		styleColors.forEach(function(item) {
			if (item.id === 'background' && isUndergroundVisible) {
				map.setPaintProperty(item.id, item.key, 'rgb(16,16,16)');
			} else if (item.stops === undefined) {
				map.setPaintProperty(item.id, item.key, getStyleColor(item, isRealtime));
			} else {
				var prop = map.getPaintProperty(item.id, item.key);
				prop.stops[item.stops][1] = getStyleColor(item, isRealtime);
				map.setPaintProperty(item.id, item.key, prop);
			}
		});
	}

	function updateAboutPopup() {
		var r = document.getElementsByClassName('mapbox-ctrl-about')[0].getBoundingClientRect();
		var staticCheck = document.getElementById('acd-static');
		var dynamicCheck = document.getElementById('acd-dynamic');
		var html = dict['description'] +
			'<input id="acd-static" class="acd-check" type="checkbox"' + (staticCheck && staticCheck.checked ? ' checked' : '') + '>' +
			'<label class="acd-label" for="acd-static">' + dict['static-update'] + '</label>' +
			'<div class="acd-content">' + lastStaticUpdate + '</div>' +
			'<input id="acd-dynamic" class="acd-check" type="checkbox"' + (dynamicCheck && dynamicCheck.checked ? ' checked' : '') + '>' +
			'<label class="acd-label" for="acd-dynamic">' + dict['dynamic-update'] + '</label>' +
			'<div class="acd-content">' +
			(lastDynamicUpdate['JR-East'] || 'N/A') + ' (' + dict['jr-east'] + ')<br>' +
			(lastDynamicUpdate['TokyoMetro'] || 'N/A') + ' (' + dict['tokyo-metro'] + ')<br>' +
			(lastDynamicUpdate['Toei'] || 'N/A') + ' (' + dict['toei'] + ')<br>' +
			(lastDynamicUpdate['HND-JAT'] || 'N/A') + ' (' + dict['hnd-jat'] + ')<br>' +
			(lastDynamicUpdate['HND-TIAT'] || 'N/A') + ' (' + dict['hnd-tiat'] + ')<br>' +
			(lastDynamicUpdate['NAA'] || 'N/A') + ' (' + dict['naa'] + ')</div>';

		aboutPopup.setLngLat(map.unproject([r.left - 5, r.top + 15])).setHTML(html);
	}
});

function updateTimetableRefData(data) {
	var lookup = buildLookup(data);

	data.forEach(function(train) {
		var railway = railwayLookup[train.r];
		var direction = train.d === railway.ascending ? 1 : -1;
		var table = train.tt;
		var length = table.length;
		var previousTableIDs = train.pt;
		var nextTableIDs = train.nt;
		var previousTrain, nextTrain, nextTable;

		if (previousTableIDs) {
			previousTrain = lookup[previousTableIDs[0]];
		}
		if (nextTableIDs) {
			nextTrain = lookup[nextTableIDs[0]];
			if (nextTrain) {
				nextTable = nextTrain.tt;
				table[length - 1].dt = nextTable[0].dt;
			}
		}

		train.start = getTime(table[0].dt) - STANDING_DURATION;
		train.end = getTime(table[length - 1].dt
			|| table[length - 1].at
			|| table[Math.max(length - 2, 0)].dt);
		train.direction = direction;
		train.altitude = railway.altitude;
		train.carComposition = railway.carComposition;
		train.previousTrain = previousTrain;
		train.nextTrain = nextTrain;
	});
}

}).catch(function(error) {
	document.getElementById('loader').style.display = 'none';
	document.getElementById('loading-error').innerHTML = 'Loading failed. Please reload the page.';
	document.getElementById('loading-error').style.display = 'block';
	throw error;
});

function colorToRGBArray(color) {
	var c = parseInt(color.replace('#', ''), 16);
	return [Math.floor(c / 65536) % 256, Math.floor(c / 256) % 256, c % 256, 255];
}

function updateDistances(line) {
	var coords = turf.getCoords(line);
	var travelled = 0;
	var distances = [];
	var nextCoord = coords[0];
	var i, currCoord, distance, bearing, slope, pitch;

	for (i = 0; i < coords.length - 1; i++) {
		currCoord = nextCoord;
		nextCoord = coords[i + 1];
		distance = turf.distance(currCoord, nextCoord);
		bearing = turf.bearing(currCoord, nextCoord);
		slope = ((nextCoord[2] || 0) - (currCoord[2] || 0)) / distance;
		pitch = Math.atan(slope / 1000);
		distances.push([travelled, bearing, slope, pitch]);
		travelled += distance;
	}

	distances.push([travelled, bearing, slope, pitch]);
	line.properties.distances = distances;
}

/**
  * Returns coordinates, altitude, bearing and patch of the train from its distance
  * @param {object} line - lineString of the railway
  * @param {number} distance - Distance from the beginning of the lineString
  * @param {number} composition - Number of cars
  * @param {number} unit - Unit of car length
  * @returns {Array} Array of coord, altitude, bearing and pitch for cars
  */
function getCoordAndBearing(line, distance, composition, unit) {
	var coords = turf.getCoords(line);
	var distances = line.properties.distances;
	var start = 0;
	var length = coords.length;
	var end = length - 1;
	var result = [];
	var center, index, i, coord, baseDistance, overshot, bearing, slope, pitch;

	distance -= unit * (composition - 1) / 2;

	while (start !== end - 1) {
		center = Math.floor((start + end) / 2);
		if (distance < distances[center][0]) {
			end = center;
		} else {
			start = center;
		}
	}
	index = start;

	for (i = 0; i < composition; distance += unit, i++) {
		while (distance > distances[index + 1][0] && index < length - 2) {
			index++;
		}
		[baseDistance, bearing, slope, pitch] = distances[index];
		coord = coords[index];
		overshot = distance - baseDistance;
		result.push({
			coord: turf.getCoord(turf.destination(coord, overshot, bearing)),
			altitude: (coord[2] || 0) + slope * overshot,
			bearing: bearing,
			pitch: pitch
		});
	}
	return result;
}

function filterFeatures(featureCollection, fn) {
	return turf.featureCollection(featureCollection.features.filter(function(feature) {
		return fn(feature.properties);
	}));
}

function setLayerProps(map, id, props) {
	map.getLayer(id).implementation.setProps(props);
}

function repeat() {
	var ids = Object.keys(animations);
	var now = performance.now();
	var i, ilen, id, animation, nextFrame, start, duration, elapsed, callback;

	for (i = 0, ilen = ids.length; i < ilen; i++) {
		id = ids[i];
		animation = animations[id];
		if (animation) {
			nextFrame = animation.nextFrame;
			if (nextFrame > now) {
				continue;
			}
			start = animation.start = animation.start || now;
			duration = animation.duration;
			elapsed = now - start;
			callback = animation.callback;
			userData = animation.userData;
			if (callback) {
				callback(Math.min(elapsed, duration), duration, userData);
			}
			animation.nextFrame = Math.max((nextFrame || 0) + 1000 / (animation.frameRate || 120), now);
			if (elapsed >= duration) {
				callback = animation.complete;
				if (callback) {
					callback(userData);
				}
				stopAnimation(id);
			}
		}
	}
	requestAnimationFrame(repeat);
}

/**
  * Starts a new animation.
  * @param {object} options - Animation options
  * @param {function} options.callback - Function called on every frame
  * @param {function} options.complete - Function called when the animation completes
  * @param {number} options.duration - Animation duration. Default is Infinity
  * @param {number} options.start - Animation start time (same timestamp as performance.now())
  * @param {number} options.userData - User data that is available in the callback function
  * @returns {number} Animation ID which can be used to stop
  */
function startAnimation(options) {
	options.duration === valueOrDefault(options.duration, Infinity);
	animations[animationID] = options;
	return animationID++;
}

/**
  * Stops an animation
  * @param {number} id - Animation ID to stop
  */
function stopAnimation(id) {
	if (animations[id]) {
		delete animations[id];
	}
}

function startTrainAnimation(callback, endCallback, distance, timeFactor, start) {
	var maxSpeed = MAX_SPEED * timeFactor;
	var acceleration = ACCELERATION * timeFactor * timeFactor;
	var maxAccelerationTime = MAX_ACCELERATION_TIME / timeFactor;
	var duration = distance < MAX_ACC_DISTANCE * 2 ?
		Math.sqrt(distance / acceleration) * 2 :
		maxAccelerationTime * 2 + (distance - MAX_ACC_DISTANCE * 2) / maxSpeed;
	var accelerationTime = Math.min(maxAccelerationTime, duration / 2);

	return startAnimation({
		callback: function(elapsed) {
			var left = duration - elapsed;
			var d;

			if (elapsed <= accelerationTime) {
				d = acceleration / 2 * elapsed * elapsed;
			} else if (left <= accelerationTime) {
				d = distance - acceleration / 2 * left * left;
			} else {
				d = MAX_ACC_DISTANCE + maxSpeed * (elapsed - maxAccelerationTime);
			}
			callback(d / distance);
		},
		complete: endCallback,
		duration: duration,
		start: start > 0 ? performance.now() - start : undefined
	});
}

function startFlightAnimation(callback, endCallback, distance, maxSpeed, acceleration, start) {
	var accelerationTime = maxSpeed / Math.abs(acceleration);
	var duration = accelerationTime / 2 + distance / maxSpeed;

	return startAnimation({
		callback: function(elapsed) {
			var left = duration - elapsed;
			var d;

			if (acceleration > 0) {
				if (elapsed <= accelerationTime) {
					d = acceleration / 2 * elapsed * elapsed;
				} else {
					d = maxSpeed * (elapsed - accelerationTime / 2);
				}
			} else {
				if (left <= accelerationTime) {
					d = distance + acceleration / 2 * left * left;
				} else {
					d = maxSpeed * elapsed;
				}
			}
			callback(d / distance);
		},
		complete: endCallback,
		duration: duration,
		start: start > 0 ? performance.now() - start : undefined
	});
}

function easeOutQuart(t) {
	return -((t = t - 1) * t * t * t - 1);
}

function concat(arr) {
	return Array.prototype.concat.apply([], arr);
}

function merge(target, source) {
	if (target === undefined || source === undefined) {
		return;
	}
	Object.keys(source).forEach(function(key) {
		target[key] = source[key];
	});
	return target;
}

function clamp(value, lower, upper) {
	return Math.min(Math.max(value, lower), upper);
}

function valueOrDefault(value, defaultValue) {
	return value === undefined ? defaultValue : value;
}

function removePrefix(value) {
	if (typeof value === 'string') {
		return value.replace(/.*:/, '');
	}
	if (Array.isArray(value)) {
		return value.map(removePrefix);
	}
	return value;
}

function loadJSON(url) {
	return new Promise(function(resolve, reject) {
		var request = new XMLHttpRequest();

		if (url.indexOf(API_URL) === 0) {
			url += a;
		}
		request.open('GET', url);
		request.onreadystatechange = function() {
			if (request.readyState === 4) {
				if (request.status === 200) {
					resolve(JSON.parse(request.response));
				} else {
					reject(Error(request.statusText));
				}
			}
		}
		request.send();
	});
}

function buildLookup(array, key) {
	var lookup = {};

	key = key || 'id';
	array.forEach(function(element) {
		lookup[element[key]] = element;
	});
	return lookup;
}

function getJSTDate(time) {
	var date = time ? new Date(time) : new Date();

	// Adjust local time to JST (UTC+9)
	date.setMinutes(date.getMinutes() + date.getTimezoneOffset() + 540);

	return date;
}

function getTime(timeString) {
	var date = getJSTDate();
	var timeStrings = (timeString || '').split(':');
	var hours = +timeStrings[0];

	// Special handling of time between midnight and 3am
	hours += (date.getHours() < 3 ? -24 : 0) + (hours < 3 ? 24 : 0);

	// Adjust JST back to local time
	return date.setHours(
		hours,
		+timeStrings[1] - (date.getTimezoneOffset() + 540),
		Math.floor(MIN_DELAY / 1000), MIN_DELAY % 1000
	);
}

function getTimeString(time) {
	var date = getJSTDate(time);

	return ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2);
}

function getStyleColor(color, isRealtime) {
	var times = SunCalc.getTimes(new Date(), 35.6814, 139.7670);
	var sunrise = getJSTDate(times.sunrise.getTime()).getTime();
	var sunset = getJSTDate(times.sunset.getTime()).getTime();
	var now = getJSTDate().getTime();
	var t, r, g, b;

	if (!isRealtime) {
		sunrise = 0;
		sunset = 1e+14;
	}

	if (now >= sunrise - 3600000 && now < sunrise) {
		// Night to sunrise
		t = (now - sunrise) / 3600000 + 1;
		r = .4 * (1 - t) + .8 * t;
		g = .4 * (1 - t) + .9 * t;
		b = .5 * (1 - t) + t;
	} else if (now >= sunrise && now < sunrise + 3600000) {
		// Sunrise to day
		t = (now - sunrise) / 3600000;
		r = .8 * (1 - t) + t;
		g = .9 * (1 - t) + t;
		b = 1;
	} else if (now >= sunrise + 3600000 && now < sunset - 3600000) {
		// Day
		r = g = b = 1;
	} else if (now >= sunset - 3600000 && now < sunset) {
		// Day to sunset
		t = (now - sunset) / 3600000 + 1;
		r = 1;
		g = (1 - t) + .9 * t;
		b = (1 - t) + .8 * t;
	} else if (now >= sunset && now < sunset + 3600000) {
		// Sunset to night
		t = (now - sunset) / 3600000;
		r = (1 - t) + .4 * t;
		g = .9 * (1 - t) + .4 * t;
		b = .8 * (1 - t) + .5 * t;
	} else {
		// Night
		r = g = .4;
		b = .5;
	}
	return 'rgba(' + [color.r * r, color.g * g, color.b * b, color.a].join(',') + ')';
}

function createCube(x, y, z, color) {
	var geometry = new THREE.BoxBufferGeometry(x, y, z);
	var material = new THREE.MeshLambertMaterial({
		color: parseInt(color.replace('#', ''), 16),
		transparent: true,
		polygonOffset: true,
		polygonOffsetFactor: Math.random()
	});
	return new THREE.Mesh(geometry, material);
}

function createDelayMarker() {
	var geometry = new THREE.SphereBufferGeometry(1.8, 32, 32);
	var material = new THREE.ShaderMaterial({
		uniforms: {glowColor: {type: "c", value: new THREE.Color(0xff9900)}},
		vertexShader: document.getElementById('vertexShader').textContent,
		fragmentShader: document.getElementById('fragmentShader').textContent,
		blending: THREE.MultiplyBlending,
		depthWrite: false
	});
	return new THREE.Mesh(geometry, material);
}

function getObjectOpacity(object, t) {
	t = valueOrDefault(t, 1);
	return isUndergroundVisible === (object.userData.altitude < 0) ?
		.9 * t + .225 * (1 - t) : .9 * (1 - t) + .225 * t;
}

function getTimetableFileName() {
	var date = getJSTDate();
	var hours = date.getHours();

	if (hours < 3) {
		date.setHours(hours - 24);
	}

	return 'timetable-' +
		(JapaneseHolidays.isHoliday(date) || date.getDay() == 6 || date.getDay() == 0 ? 'holiday' : 'weekday') +
		'.json';
}

function setSectionData(train, index) {
	var table = train.tt;
	var delay = train.delay || 0;
	var now = Date.now();
	var index = valueOrDefault(index, table.reduce(function(acc, cur, i) {
		return getTime(cur.dt) + delay <= now ? i : acc;
	}, 0));
	var current = table[index];
	var next = table[index + 1];
	var stations = railwayLookup[train.r].stations;
	var departureStation = current.ds || current.as;
	var arrivalStation = next && (next.as || next.ds);
	var currentSection, nextSection;

	if (train.direction > 0) {
		currentSection = stations.indexOf(departureStation);
		nextSection = stations.indexOf(arrivalStation, currentSection);
	} else {
		currentSection = stations.lastIndexOf(departureStation);
		nextSection = stations.lastIndexOf(arrivalStation, currentSection);
	}

	train.timetableIndex = index;
	train.departureStation = departureStation;
	train.departureTime = current.dt || current.at;

	if (currentSection >= 0 && nextSection >= 0) {
		train.sectionIndex = currentSection;
		train.sectionLength = nextSection - currentSection;
		train.arrivalStation = arrivalStation;
		train.arrivalTime = next.at || next.dt;

		return true;
	}

	train.arrivalStation = undefined;
	train.arrivalTime = undefined;
}

function getLang() {
	var match = location.search.match(/lang=(.*?)(&|$)/);
	var lang = match ? decodeURIComponent(match[1]).substring(0, 2) : '';

	if (lang.match(/ja|en|ko|zh|th|ne/)) {
		return lang;
	}

	lang = (window.navigator.languages && window.navigator.languages[0]) ||
		window.navigator.language ||
		window.navigator.userLanguage ||
		window.navigator.browserLanguage || '';
	lang = lang.substring(0, 2);

	return lang.match(/ja|en|ko|zh|th|ne/) ? lang : 'en';
}
