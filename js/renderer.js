        let API_BASE = localStorage.getItem('api_base') || 'http://localhost:13480';
        let STATIONS_URL = localStorage.getItem('stations_url') || 'data/stations.json';
        
        document.getElementById('client_api_base').value = API_BASE;
        document.getElementById('client_stations_url').value = STATIONS_URL;

        function saveClientSettings() {
            API_BASE = document.getElementById('client_api_base').value;
            STATIONS_URL = document.getElementById('client_stations_url').value;
            localStorage.setItem('api_base', API_BASE);
            localStorage.setItem('stations_url', STATIONS_URL);
            showMessage('Client settings saved', 'success');
            fetchAvailableStations();
            updateUI();
        }

        let metricsHistory = { labels: [], fetched: [], failed: [] };
        let poolHistory = {
            threadActive: [],
            threadPending: [],
            discoveryActive: [],
            discoveryPending: [],
            bufferAvailable: [],
            bufferTotal: [],
            labels: []
        };
        let metricsChart = null;
        let poolCharts = {
            thread: null,
            discovery: null,
            buffer: null
        };
        let allStations = [];
        let monitoredStations = [];
        let lastKnownRunning = null;
        let isSelectionMode = false;
        let map;
        let selectionStart = null;
        let selectionRect = null;

        function initMap() {
            map = new maplibregl.Map({
                container: 'map',
                style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json', // Basic style
                center: [-98.5795, 39.8283], // Center of USA
                zoom: 3
            });

            map.on('load', () => {
                map.addSource('stations', {
                    type: 'geojson',
                    data: {
                        type: 'FeatureCollection',
                        features: []
                    }
                });

                map.addLayer({
                    id: 'stations-layer',
                    type: 'circle',
                    source: 'stations',
                    paint: {
                        'circle-radius': 6,
                        'circle-color': [
                            'case',
                            ['get', 'monitored'],
                            '#004E01', // Monitored: Green
                            '#D40000'  // Available: Red
                        ],
                        'circle-stroke-width': 2,
                        'circle-stroke-color': '#818181'
                    }
                });

                // Tooltip on hover
                const popup = new maplibregl.Popup({
                    closeButton: false,
                    closeOnClick: false
                });

                map.on('mouseenter', 'stations-layer', (e) => {
                    map.getCanvas().style.cursor = 'pointer';
                    const coordinates = e.features[0].geometry.coordinates.slice();
                    const { code, name, monitored } = e.features[0].properties;
                    const description = `<strong>${code}</strong><br>${name}<br>${monitored ? 'Monitored' : 'Available'}`;

                    popup.setLngLat(coordinates).setHTML(description).addTo(map);
                });

                map.on('mouseleave', 'stations-layer', () => {
                    map.getCanvas().style.cursor = '';
                    popup.remove();
                });

                // Click to add/remove
                map.on('click', 'stations-layer', (e) => {
                    if (isSelectionMode) return;
                    const { code, monitored } = e.features[0].properties;
                    if (monitored) {
                        removeStation(code);
                    } else {
                        addStationToFetcher(code);
                    }
                });

                // Selection rectangle handlers
                map.on('mousedown', (e) => {
                    if (!isSelectionMode) return;
                    
                    // Prevent default to avoid map interaction
                    e.originalEvent.preventDefault();
                    
                    if (selectionRect) selectionRect.remove();
                    
                    selectionStart = e.point;
                    selectionRect = document.createElement('div');
                    selectionRect.className = 'selection-rect';
                    map.getCanvasContainer().appendChild(selectionRect);
                });

                map.on('mousemove', (e) => {
                    if (!isSelectionMode || !selectionStart || !selectionRect) return;

                    const current = e.point;
                    const left = Math.min(selectionStart.x, current.x);
                    const top = Math.min(selectionStart.y, current.y);
                    const width = Math.abs(selectionStart.x - current.x);
                    const height = Math.abs(selectionStart.y - current.y);

                    selectionRect.style.left = left + 'px';
                    selectionRect.style.top = top + 'px';
                    selectionRect.style.width = width + 'px';
                    selectionRect.style.height = height + 'px';
                });

                map.on('mouseup', (e) => {
                    if (!isSelectionMode || !selectionStart) return;

                    const selectionEnd = e.point;
                    
                    if (selectionRect) {
                        selectionRect.remove();
                        selectionRect = null;
                    }
                    
                    const p1 = selectionStart;
                    const p2 = selectionEnd;
                    selectionStart = null;

                    // Calculate which stations are in the bounding box
                    if (Math.abs(p1.x - p2.x) > 5 || Math.abs(p1.y - p2.y) > 5) {
                        const sw = map.unproject([Math.min(p1.x, p2.x), Math.max(p1.y, p2.y)]);
                        const ne = map.unproject([Math.max(p1.x, p2.x), Math.min(p1.y, p2.y)]);
                        
                        const minLng = sw.lng;
                        const maxLng = ne.lng;
                        const minLat = sw.lat;
                        const maxLat = ne.lat;

                        const stationsToAdd = allStations.filter(s => 
                            s.lon >= minLng && s.lon <= maxLng && 
                            s.lat >= minLat && s.lat <= maxLat &&
                            !monitoredStations.some(ms => ms.name === s.code)
                        );

                        if (stationsToAdd.length > 0) {
                            console.log(`Adding ${stationsToAdd.length} stations from region selection`);
                            
                            (async () => {
                                for (const s of stationsToAdd) {
                                    await addStationToFetcher(s.code, true);
                                }
                                updateUI();
                                showMessage(`Added ${stationsToAdd.length} stations from selection`, 'success');
                            })();
                        }
                    }
                });

                updateMapMarkers();
            });
        }

        function updateMapMarkers() {
            if (!map || !map.getSource('stations')) return;

            const features = allStations.map(s => {
                const isMonitored = monitoredStations.some(ms => ms.name === s.code);
                return {
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [s.lon, s.lat]
                    },
                    properties: {
                        code: s.code,
                        name: s.name,
                        monitored: isMonitored
                    }
                };
            });

            map.getSource('stations').setData({
                type: 'FeatureCollection',
                features: features
            });
        }

        function togglePanel(titleElement) {
            const panel = titleElement.parentElement;
            panel.classList.toggle('collapsed');
        }

        function toggleSelectionMode() {
            isSelectionMode = !isSelectionMode;
            const btn = document.getElementById('selectionModeBtn');
            btn.classList.toggle('active', isSelectionMode);
            btn.textContent = `Selection Mode: ${isSelectionMode ? 'ON' : 'OFF'}`;
            
            if (map) {
                if (isSelectionMode) {
                    map.dragPan.disable();
                    map.dragRotate.disable();
                    map.scrollZoom.disable();
                    map.touchZoomRotate.disable();
                    map.boxZoom.disable();
                    map.doubleClickZoom.disable();
                    map.getCanvas().style.cursor = 'crosshair';
                } else {
                    map.dragPan.enable();
                    map.dragRotate.enable();
                    map.scrollZoom.enable();
                    map.touchZoomRotate.enable();
                    map.boxZoom.enable();
                    map.doubleClickZoom.enable();
                    map.getCanvas().style.cursor = '';
                }
            }
            console.log(`Selection mode: ${isSelectionMode}`);
        }
        
        async function fetchAvailableStations() {
            const status = document.getElementById('stationLoadStatus');
            try {
                console.log(`📡 Loading stations from ${STATIONS_URL}...`);
                const response = await fetch(STATIONS_URL);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                const stations = data.stations || [];
                if (!stations.length) {
                    throw new Error('No stations in response');
                }
                allStations = stations.filter(s => s.code && s.name).sort((a, b) => a.code.localeCompare(b.code));
                status.textContent = `✓ Loaded ${allStations.length} stations`;
                status.style.color = '#4CAF50';
            } catch (error) {
                console.error('❌ Failed to load stations:', error);
                // Try fallback if STATIONS_URL is not the default relative one
                if (STATIONS_URL !== 'data/stations.json') {
                    console.log('Trying fallback data/stations.json...');
                    try {
                        const fallbackResponse = await fetch('data/stations.json');
                        if (fallbackResponse.ok) {
                            const data = await fallbackResponse.json();
                            allStations = data.stations.filter(s => s.code && s.name).sort((a, b) => a.code.localeCompare(b.code));
                            status.textContent = `⚠ Loaded ${allStations.length} from local fallback`;
                            status.style.color = '#ff9800';
                            updateStationSelector();
                            updateMapMarkers();
                            return;
                        }
                    } catch (e) {}
                }
                allStations = [
                    { code: 'KTLX', name: 'Oklahoma City, OK', lat: 35.333, lon: -97.278 },
                    { code: 'KCRP', name: 'Corpus Christi, TX', lat: 27.784, lon: -97.511 },
                    { code: 'KEWX', name: 'Austin/San Antonio, TX', lat: 29.704, lon: -98.029 },
                    { code: 'KAMA', name: 'Amarillo, TX', lat: 35.233, lon: -101.709 },
                    { code: 'KDVN', name: 'Davenport, IA', lat: 41.612, lon: -90.581 },
                    { code: 'KOUN', name: 'Norman, OK', lat: 35.236, lon: -97.462 },
                    { code: 'KBRO', name: 'Brownsville, TX', lat: 25.916, lon: -97.419 }
                ].sort((a, b) => a.code.localeCompare(b.code));
                status.textContent = '⚠ Using built-in station list';
                status.style.color = '#ff9800';
            }
            updateStationSelector();
            updateMapMarkers();
        }
        
        function updateStationSelector(filter = "") {
            const select = document.getElementById('availableStations');
            const selectedStations = Array.from(
                document.querySelectorAll('.station-badge')
            ).map(b => b.firstChild.textContent.split(' ')[0].trim()); // Extract code from badge
            const available = allStations
                .filter(s => !selectedStations.includes(s.code))
                .filter(s => 
                    s.code.toUpperCase().includes(filter.toUpperCase()) || 
                    s.name.toUpperCase().includes(filter.toUpperCase())
                );
            if (!available.length) {
                select.innerHTML = `<option disabled selected>No available stations</option>`;
                return;
            }
            select.innerHTML = available
                .map(s => `<option value="${s.code}">${s.code} - ${s.name}</option>`)
                .join('');
        }
        
        async function addSelectedStation() {
            const station = document.getElementById('availableStations').value;
            if (!station) return;
            await addStationToFetcher(station);
        }
        
        async function addStationToFetcher(station, skipUpdate = false) {
            try {
                const response = await fetch(`${API_BASE}/api/stations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: station })
                });
                const result = await response.json();
                if (result.success) {
                    //showMessage(`Added ${station}`, 'success');
                    if (!skipUpdate) updateUI();
                } else {
                    showMessage('Error: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                showMessage('Network error: ' + error.message, 'error');
            }
        }
        
        async function removeStation(name) {
            try {
                const response = await fetch(`${API_BASE}/api/stations/${name}`, { method: 'DELETE' });
                const result = await response.json();
                if (result.success) {
                    showMessage(`Removed ${name}`, 'success');
                    updateUI();
                } else {
                    showMessage('Error: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                showMessage('Network error: ' + error.message, 'error');
            }
        }
        
        async function togglePause() {
            const isRunning = lastKnownRunning;
            const btn = document.getElementById('pauseBtn');
            btn.disabled = true;
            
            try {
                const endpoint = isRunning ? '/api/pause' : '/api/resume';
                const response = await fetch(`${API_BASE}${endpoint}`, { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    showMessage(isRunning ? 'System paused' : 'System resumed', 'success');
                    updateUI();
                } else {
                    showMessage('Error: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                showMessage('Network error: ' + error.message, 'error');
            } finally {
                btn.disabled = false;
            }
        }

        async function fetchConfig() {
            try {
                const response = await fetch(`${API_BASE}/api/config`);
                const config = await response.json();
                
                document.getElementById('auto_cleanup_enabled').checked = config.auto_cleanup_enabled;
                document.getElementById('buffer_pool_size').value = config.buffer_pool_size;
                document.getElementById('buffer_size_mb').value = config.buffer_size_mb;
                document.getElementById('cleanup_interval_seconds').value = config.cleanup_interval_seconds;
                document.getElementById('fetcher_thread_pool_size').value = config.fetcher_thread_pool_size;
                document.getElementById('max_frames_per_station').value = config.max_frames_per_station;
                document.getElementById('scan_interval_seconds').value = config.scan_interval_seconds;
            } catch (error) {
                console.error('Failed to fetch config:', error);
            }
        }
        
        async function updateConfig() {
            const config = {
                auto_cleanup_enabled: document.getElementById('auto_cleanup_enabled').checked,
                buffer_pool_size: parseInt(document.getElementById('buffer_pool_size').value),
                buffer_size_mb: parseInt(document.getElementById('buffer_size_mb').value),
                cleanup_interval_seconds: parseInt(document.getElementById('cleanup_interval_seconds').value),
                fetcher_thread_pool_size: parseInt(document.getElementById('fetcher_thread_pool_size').value),
                max_frames_per_station: parseInt(document.getElementById('max_frames_per_station').value),
                scan_interval_seconds: parseInt(document.getElementById('scan_interval_seconds').value)
            };
            
            try {
                const response = await fetch(`${API_BASE}/api/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });
                const result = await response.json();
                if (result.success) {
                    showMessage('Configuration updated', 'success');
                } else {
                    showMessage('Error updating configuration', 'error');
                }
            } catch (error) {
                showMessage('Network error: ' + error.message, 'error');
            }
        }
        
        async function updateUI() {
            try {
                const [stations, metrics, status] = await Promise.all([
                    fetch(`${API_BASE}/api/stations`).then(r => {
                        if (!r.ok) throw new Error(`Stations: ${r.status}`);
                        return r.json();
                    }),
                    fetch(`${API_BASE}/api/metrics`).then(r => {
                        if (!r.ok) throw new Error(`Metrics: ${r.status}`);
                        return r.json();
                    }),
                    fetch(`${API_BASE}/api/status`).then(r => {
                        if (!r.ok) throw new Error(`Status: ${r.status}`);
                        return r.json();
                    })
                ]);
                updateStations(stations);
                updateMetrics(metrics);
                updateStatus(status);
                updateChart(metrics);
                
                document.getElementById('statusDot').style.opacity = '1';
                if (!status.fetcher_running) {
                    document.getElementById('statusText').textContent = 'Paused';
                }
            } catch (error) { 
                console.error('Update error:', error);
                document.getElementById('statusDot').classList.remove('running');
                document.getElementById('statusDot').style.opacity = '0.5';
                document.getElementById('statusText').textContent = 'Disconnected';
                document.getElementById('fetcherState').textContent = '● Offline';
                document.getElementById('fetcherState').style.color = '#f44336';
            }
        }
        
        function updateStations(stations) {
            monitoredStations = stations;
            const badges = document.getElementById('stationBadges');
            badges.innerHTML = stations.length > 0 
                ? stations.map(s => {
                    const fullStation = allStations.find(as => as.code === s.name);
                    const displayName = fullStation ? `${fullStation.code} - ${fullStation.name}` : s.name;
                    return `<div class="station-badge">${displayName} <span class="remove" onclick="removeStation('${s.name}')">×</span></div>`;
                }).join('')
                : '<div class="empty-state">No stations selected</div>';
            updateStationSelector(document.getElementById('stationSearch').value);
            updateMapMarkers();
        }
        
        function isVersionGreaterOrEqual(current, target) {
            if (!current) return false;
            const c = current.split('.').map(Number);
            const t = target.split('.').map(Number);
            for (let i = 0; i < Math.max(c.length, t.length); i++) {
                const cv = c[i] || 0;
                const tv = t[i] || 0;
                if (cv > tv) return true;
                if (cv < tv) return false;
            }
            return true;
        }

        function updateMetrics(metrics) {
            const fetched = metrics.frames_fetched || 0;
            const failed = metrics.frames_failed || 0;
            const total = fetched + failed;
            const uptime = metrics.uptime_seconds || 0;
            const version = metrics.version || '1.0.0';
            const isNewVersion = isVersionGreaterOrEqual(version, '1.1.0');
            
            // Show/hide new metrics based on version
            const newMetricElements = [
                'avgFramesPerMinCard', 'diskUsageGBCard', 'diskUsageMBCard',
                'resourcePoolsPanel', 'processMetricsPanel', 'stationStatsPanel'
            ];
            newMetricElements.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = isNewVersion ? '' : 'none';
            });

            if (!isNewVersion) {
                // If not new version, we still want to update standard metrics but skip the rest
                document.getElementById('framesFetched').textContent = fetched;
                document.getElementById('framesFailed').textContent = failed;
                document.getElementById('uptime').textContent = formatTime(uptime);
                const successRate = total > 0 ? ((fetched / total) * 100).toFixed(1) : 'N/A';
                document.getElementById('successRate').textContent = successRate !== 'N/A' ? successRate + '%' : 'N/A';
                
                metricsHistory.labels.push(new Date().toLocaleTimeString());
                metricsHistory.fetched.push(fetched);
                metricsHistory.failed.push(failed);
                if (metricsHistory.labels.length > 12) {
                    metricsHistory.labels.shift();
                    metricsHistory.fetched.shift();
                    metricsHistory.failed.shift();
                }
                return;
            }

            document.getElementById('framesFetched').textContent = fetched;
            document.getElementById('framesFailed').textContent = failed;
            document.getElementById('uptime').textContent = formatTime(uptime);
            
            // Use API provided success rate or calculate if not available
            const successRate = metrics.success_rate !== undefined 
                ? metrics.success_rate.toFixed(1) 
                : (total > 0 ? ((fetched / total) * 100).toFixed(1) : 'N/A');
            document.getElementById('successRate').textContent = successRate !== 'N/A' ? successRate + '%' : 'N/A';
            
            // Handle new metric fields
            document.getElementById('avgFramesPerMin').textContent = (metrics.avg_frames_per_minute || 0).toFixed(2);
            document.getElementById('diskUsageGB').textContent = (metrics.disk_usage_gb || 0).toFixed(2);
            document.getElementById('diskUsageMB').textContent = (metrics.disk_usage_mb || 0);

            // Update Resource Pools
            if (metrics.thread_pool) {
                const active = metrics.thread_pool.active_threads || 0;
                const pending = metrics.thread_pool.pending_tasks || 0;
                document.getElementById('threadPoolActive').textContent = active;
                document.getElementById('threadPoolPending').textContent = pending;
                document.getElementById('threadPoolWorkers').textContent = metrics.thread_pool.worker_count || 0;
                poolHistory.threadActive.push(active);
                poolHistory.threadPending.push(pending);
            } else {
                poolHistory.threadActive.push(0);
                poolHistory.threadPending.push(0);
            }

            if (metrics.discovery_pool) {
                const active = metrics.discovery_pool.active_threads || 0;
                const pending = metrics.discovery_pool.pending_tasks || 0;
                document.getElementById('discoveryPoolActive').textContent = active;
                document.getElementById('discoveryPoolPending').textContent = pending;
                document.getElementById('discoveryPoolWorkers').textContent = metrics.discovery_pool.worker_count || 0;
                poolHistory.discoveryActive.push(active);
                poolHistory.discoveryPending.push(pending);
            } else {
                poolHistory.discoveryActive.push(0);
                poolHistory.discoveryPending.push(0);
            }

            if (metrics.buffer_pool) {
                const available = metrics.buffer_pool.available_buffers || 0;
                const total = metrics.buffer_pool.total_buffers || 0;
                document.getElementById('bufferPoolAvailable').textContent = available;
                document.getElementById('bufferPoolTotal').textContent = total;
                document.getElementById('bufferPoolSize').textContent = Math.round((metrics.buffer_pool.buffer_size || 0) / (1024 * 1024));
                poolHistory.bufferAvailable.push(available);
                poolHistory.bufferTotal.push(total);
            } else {
                poolHistory.bufferAvailable.push(0);
                poolHistory.bufferTotal.push(0);
            }

            const nowLabel = new Date().toLocaleTimeString();
            poolHistory.labels.push(nowLabel);
            if (poolHistory.labels.length > 60) {
                poolHistory.labels.shift();
                poolHistory.threadActive.shift();
                poolHistory.threadPending.shift();
                poolHistory.discoveryActive.shift();
                poolHistory.discoveryPending.shift();
                poolHistory.bufferAvailable.shift();
                poolHistory.bufferTotal.shift();
            }
            updatePoolCharts();

            // Update Process Metrics
            document.getElementById('activeDiscoveryCount').textContent = (metrics.active_discovery_scans && metrics.active_discovery_scans.count) || 0;
            document.getElementById('storagePendingTasks').textContent = metrics.storage_pending_tasks || 0;
            document.getElementById('indexCacheSize').textContent = metrics.index_cache_size || 0;
            document.getElementById('totalStationsTracked').textContent = metrics.total_stations_tracked || 0;

            // Update Station Statistics
            updateStationStatsTable(metrics.station_stats || {});
            
            metricsHistory.labels.push(new Date().toLocaleTimeString());
            metricsHistory.fetched.push(fetched);
            metricsHistory.failed.push(failed);
            if (metricsHistory.labels.length > 12) {
                metricsHistory.labels.shift();
                metricsHistory.fetched.shift();
                metricsHistory.failed.shift();
            }
        }

        function formatApiTimestamp(ts) {
            if (!ts) return 'Never';
            // Handle large nanosecond timestamps (64-bit int as string or large number)
            // If it's larger than typical millisecond timestamp (e.g. > 1e14)
            const numTs = Number(ts);
            if (numTs > 1e14) {
                return new Date(numTs / 1_000_000).toLocaleTimeString();
            }
            return new Date(numTs * 1000).toLocaleTimeString();
        }

        function updateStationStatsTable(stats) {
            const tbody = document.getElementById('stationStatsBody');
            const stations = Object.keys(stats);
            
            if (stations.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#666;">No station data available</td></tr>';
                return;
            }

            tbody.innerHTML = stations.map(code => {
                const s = stats[code];
                const lastFetch = formatApiTimestamp(s.last_fetch_timestamp);
                const lastScan = formatApiTimestamp(s.last_scan_timestamp);
                
                return `<tr>
                    <td><strong>${code}</strong></td>
                    <td>${s.frames_fetched || 0}</td>
                    <td>${s.frames_failed || 0}</td>
                    <td>${lastFetch}</td>
                    <td>${s.last_frame_timestamp || 'N/A'}</td>
                    <td>${lastScan}</td>
                </tr>`;
            }).join('');
        }
        
        function updatePoolCharts() {
            const chartConfigs = [
                { 
                    id: 'threadPoolChart', 
                    title: 'Thread Pool',
                    datasets: [
                        { label: 'Active', data: poolHistory.threadActive, color: '#667eea' },
                        { label: 'Pending', data: poolHistory.threadPending, color: '#a78bfa' }
                    ],
                    key: 'thread' 
                },
                { 
                    id: 'discoveryPoolChart', 
                    title: 'Discovery Pool',
                    datasets: [
                        { label: 'Active', data: poolHistory.discoveryActive, color: '#ed64a6' },
                        { label: 'Pending', data: poolHistory.discoveryPending, color: '#fbb6ce' }
                    ],
                    key: 'discovery' 
                },
                { 
                    id: 'bufferPoolChart', 
                    title: 'Buffer Pool',
                    datasets: [
                        { label: 'Available', data: poolHistory.bufferAvailable, color: '#4299e1' },
                        { label: 'Total', data: poolHistory.bufferTotal, color: '#90cdf4' }
                    ],
                    key: 'buffer' 
                }
            ];

            chartConfigs.forEach(cfg => {
                const ctx = document.getElementById(cfg.id);
                if (!ctx) return;

                if (poolCharts[cfg.key]) {
                    poolCharts[cfg.key].destroy();
                }

                poolCharts[cfg.key] = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: poolHistory.labels,
                        datasets: cfg.datasets.map(ds => ({
                            label: ds.label,
                            data: ds.data,
                            borderColor: ds.color,
                            backgroundColor: ds.color + '22',
                            tension: 0.4,
                            fill: true,
                            pointRadius: 0
                        }))
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { 
                                display: true,
                                position: 'top',
                                labels: { color: '#888', boxWidth: 8, font: { size: 9 } }
                            },
                            title: { display: false }
                        },
                        scales: {
                            y: { beginAtZero: true, ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#252525' } },
                            x: { display: false }
                        }
                    }
                });
            });
        }

        function updateStatus(status) {
            const isRunning = status.fetcher_running;
            lastKnownRunning = isRunning;
            
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            const btn = document.getElementById('pauseBtn');
            const state = document.getElementById('pauseState');
            const fetcherStateEl = document.getElementById('fetcherState');
            
            fetcherStateEl.style.color = ''; // Reset color
            
            if (isRunning) {
                dot.classList.add('running');
                text.textContent = 'Running';
                btn.className = 'control-btn running';
                btn.querySelector('span').textContent = 'RUNNING';
                state.textContent = 'Active';
                fetcherStateEl.textContent = '● Running';
            } else {
                dot.classList.remove('running');
                text.textContent = 'Paused';
                btn.className = 'control-btn paused';
                btn.querySelector('span').textContent = 'PAUSED';
                state.textContent = 'Ready';
                fetcherStateEl.textContent = '● Paused';
            }
        }
        
        function updateChart(metrics) {
            const ctx = document.getElementById('metricsChart');
            if (!ctx) return;
            
            if (metricsChart) {
                metricsChart.destroy();
            }
            
            metricsChart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: metricsHistory.labels,
                    datasets: [
                        {
                            label: 'Fetched',
                            data: metricsHistory.fetched,
                            borderColor: '#4CAF50',
                            backgroundColor: 'rgba(76, 175, 80, 0.1)',
                            tension: 0.4,
                            fill: true
                        },
                        {
                            label: 'Failed',
                            data: metricsHistory.failed,
                            borderColor: '#f44336',
                            backgroundColor: 'rgba(244, 67, 54, 0.1)',
                            tension: 0.4,
                            fill: true
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: '#e0e0e0' } }
                    },
                    scales: {
                        y: { ticks: { color: '#888' }, grid: { color: '#2a2a2a' } },
                        x: { ticks: { color: '#888' }, grid: { color: '#2a2a2a' } }
                    }
                }
            });
        }
        
        function formatTime(seconds) {
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
            return Math.floor(seconds / 3600) + 'h';
        }
        
        function showMessage(message, type) {
            const div = document.getElementById('message');
            div.innerHTML = `<div class="message ${type}">${message}</div>`;
            setTimeout(() => { div.innerHTML = ''; }, 3000);
        }
        
        fetchAvailableStations();
        fetchConfig();
        updateUI();
        initMap();
        setInterval(updateUI, 5000);
