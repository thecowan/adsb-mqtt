const server = process.env.MQTT_HOST
const user = process.env.MQTT_USER
const pass = process.env.MQTT_PASS
const topic = process.env.MQTT_TOPIC || "adsb/dump"
const aircraftURL = process.env.AIRCRAFT_JSON_URL || "http://tar1090/data/aircraft.json"
const faJsonURL = process.env.FA_JSON_URL || "http://piaware:8080/status.json"
const fr24JsonURL = process.env.FR24_JSON_URL || "http://fr24:8754/monitor.json"
const pfJsonURL = process.env.PF_JSON_URL || "http://pfclient:30053/ajax/stats"
const rawStatus = true
const checkContainers = process.env.CHECK_CONTAINERS ? process.env.CHECK_CONTAINERS.split(",") : ['readsb', 'piaware', 'adsbx', 'opensky', 'rbfeeder', 'fr24']
const station_lat = parseFloat(process.env.LAT)
const station_long = parseFloat(process.env.LONG)
const mqttInterval = process.env.MQTT_INTERVAL ? parseInt(process.env.MQTT_INTERVAL) : 5000

const mqtt = require('mqtt')
const fetch = require('node-fetch')
const exec = require("child_process").exec;
const client = mqtt.connect('mqtt://' + server + '/', {'username': user, 'password': pass})
var GreatCircle = require('great-circle')


var lasttime = 0
var lastcount = 0

function pollUpdate() {
  fetch(aircraftURL)
    .then(res => res.json())
    .then(json => {
      console.log(json)
      var o = {}
      var timestamp = json['now']
      var messages = json['messages']
      o['timestamp'] = timestamp
      o['positions'] = json['aircraft'].filter(function(e) {
        return 'seen_pos' in e
      }).length;
      o['aircraft'] = json['aircraft'].filter(function(e) {
        return 'seen' in e && e['seen'] < 60
      }).length;
      o['nearest_aircraft'] = json['aircraft'].filter(function(e) {
        return e['alt_baro'] != 'ground' && 'seen_pos' in e
      })
      o['nearest_aircraft'].forEach(function(e) {
	e['distance'] = GreatCircle.distance(station_lat, station_long, e['lat'], e['lon'] )
	e['bearing'] = GreatCircle.bearing(station_lat, station_long, e['lat'], e['lon'] )
      })
      o['nearest_aircraft'].sort(function(a, b) {
	return a['distance'] - b['distance']
      })

      o['messages_total'] = messages
      if (lasttime > 0 && (timestamp - lasttime) > 0) {
        o['messages_rate'] = (messages - lastmessages) / (timestamp - lasttime)
      }
      lasttime = timestamp
      lastmessages = messages
      o['feeds'] = {}
      promises = []
      if (faJsonURL != "") {
        promises.push(fetch(faJsonURL)
          .then(res => res.json())
	  .then(faJson => {
            console.log(faJson)
            fa = {}
            fa['flightaware_site_url'] = faJson['site_url']
            fa['piaware_status'] = faJson['piaware']['status']
            fa['piaware_message'] = faJson['piaware']['message']
            fa['mlat_status'] = faJson['mlat']['status']
            fa['mlat_message'] = faJson['mlat']['message']
            fa['radio_status'] = faJson['radio']['status']
            fa['radio_message'] = faJson['radio']['message']
            fa['connect_status'] = faJson['adept']['status']
            fa['connect_message'] = faJson['adept']['message']
	    if (rawStatus) {
              fa['raw'] = faJson
	    }
	    
            o['feeds']['piaware'] = fa

	  }))
      }
      if (fr24JsonURL != "") {
        promises.push(fetch(fr24JsonURL)
          .then(res => res.json())
	  .then(frJson => {
            console.log(frJson)
            fr = {}
            fr['version'] = frJson['build_version']
            fr['feed_alias'] = frJson['feed_alias']
            fr['aircraft_tracked'] = frJson['d11_map_size']
            fr['aircraft_uploaded'] = frJson['feed_num_ac_tracked']
            if (frJson['feed_status'] == 'connected') {
	      fr['connected'] = 'Yes'
	      fr['connect_mode'] = frJson['feed_current_mode']
	    } else {
	      fr['connected'] = 'N/A'
	      fr['connect_error'] = frJson['feed_last_config_info']
	    }
	    if (rawStatus) {
              fr['raw'] = frJson
	    }
            o['feeds']['flightradar24'] = fr
	  }))
      }
      if (pfJsonURL != "") {
        promises.push(fetch(pfJsonURL)
          .then(res => res.json())
	  .then(pfJson => {
            console.log(pfJson)
            pf = {}
            pf['version'] = pfJson['client_version']
            pf['start_time'] = pfJson['executable_start_time']
            pf['data_upload_today_bytes'] = pfJson['master_server_bytes_out']
            pf['data_upload_prev_bytes'] = pfJson['prev_master_server_bytes_out']
            pf['modes_today_packets'] = pfJson['total_modes_packets']
            pf['modes_prev_packets'] = pfJson['prev_total_modes_packets']
            pf['modeac_today_packets'] = pfJson['total_modeac_packets']
            pf['modeac_prev_packets'] = pfJson['prev_total_modeac_packets']
	    if (rawStatus) {
              pf['raw'] = pfJson
	    }
            o['feeds']['planefinder'] = pf
	  }))
      }
      if (checkContainers.length > 0) {
        o['containers'] = {}
	checkContainers.forEach(e => {
	  console.log(e);
          promises.push(new Promise((resolve, reject) => {
            exec('docker inspect ' + e, { maxBuffer: 1024 * 500 }, (error, stdout, stderr) => {
              o['containers'][e] = 0
              if (!error) {
                let j = JSON.parse(stdout);
		if('Health' in j[0]['State'] && j[0]['State']['Health']['Status'] == 'healthy') {
		  o['containers'][e] = 1
		}
              }
              resolve(stdout ? true : false);
            })
          }));
	});
      }
      Promise.all(promises)
        .then(out => {
          client.publish(topic, JSON.stringify(o))
        })
    })
  setTimeout(pollUpdate, mqttInterval)
}

client.on('connect', pollUpdate)

