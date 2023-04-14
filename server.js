const server = process.env.MQTT_HOST
const user = process.env.MQTT_USER
const pass = process.env.MQTT_PASS
const port = process.env.MQTT_PORT || 1883
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
const aircraftDbFile = process.env.AIRCRAFT_DB_FILE
const routeDbFile = process.env.ROUTE_DB_FILE
const mqtt = require('mqtt')
const fetch = require('node-fetch')
const exec = require("child_process").exec;
const client = mqtt.connect('mqtt://' + server + ':' + port + '/', {'username': user, 'password': pass})
var GreatCircle = require('great-circle')
const { parse} = require('@fast-csv/parse')
const { EOL } = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

var lasttime = 0
var lastcount = 0
var routeDb

function CPA(speed1,course1,speed2,course2,range,bearing)
{
  var DTR = Math.PI / 180;
  var x,y,xVel,yVel,dot,a,b,cpa;


  x = range * Math.cos(DTR*bearing);
  y = range * Math.sin(DTR*bearing);
  xVel = speed2 * Math.cos(DTR*course2) - speed1 * Math.cos(DTR*course1);
  yVel = speed2 * Math.sin(DTR*course2) - speed1 * Math.sin(DTR*course1);
  dot = x * xVel + y * yVel;
  if (dot >= 0.0) return;
  a = xVel * xVel + yVel * yVel;
  b = 2 * dot;
  //if (Math.abs(a) < 0.0001 || Math.abs(b) > 24 * Math.abs(a)) return "CPA > 12";
  if (Math.abs(a) < 0.0001 || Math.abs(b) > 24 * Math.abs(a)) return;
  cpa = range * range - ((b*b)/(4*a));
  if (cpa <= 0.0) return [0, 60*(-b/(2*a))];
  cpa = Math.sqrt(cpa);
  return [cpa, 60*(-b/(2*a))];
}

function distanceAfterSeconds(speedKts, timeSeconds) {
  var speedMs = speedKts * 0.51444444444444;
  var distanceM = speedMs * timeSeconds;
  return distanceM;
}

// From https://stackoverflow.com/questions/19352921/how-to-use-direction-angle-and-speed-to-calculate-next-times-latitude-and-longi
function destinationPoint(lat, lon, distance, bearing) {
     var radius = 6371e3; // (Mean) radius of earth

     var toRadians = function(v) { return v * Math.PI / 180; };
     var toDegrees = function(v) { return v * 180 / Math.PI; };

     // sinφ2 = sinφ1·cosδ + cosφ1·sinδ·cosθ
     // tanΔλ = sinθ·sinδ·cosφ1 / cosδ−sinφ1·sinφ2
     // see mathforum.org/library/drmath/view/52049.html for derivation

     var δ = Number(distance) / radius; // angular distance in radians
     var θ = toRadians(Number(bearing));

     var φ1 = toRadians(Number(lat));
     var λ1 = toRadians(Number(lon));

     var sinφ1 = Math.sin(φ1), cosφ1 = Math.cos(φ1);
     var sinδ = Math.sin(δ), cosδ = Math.cos(δ);
     var sinθ = Math.sin(θ), cosθ = Math.cos(θ);

     var sinφ2 = sinφ1*cosδ + cosφ1*sinδ*cosθ;
     var φ2 = Math.asin(sinφ2);
     var y = sinθ * sinδ * cosφ1;
     var x = cosδ - sinφ1 * sinφ2;
     var λ2 = λ1 + Math.atan2(y, x);

     return [toDegrees(φ2), (toDegrees(λ2)+540)%360-180]; // normalise to −180..+180°
  }



var imgCache = {}
var infoCache = {}
var routeCache = {}

function pollUpdate() {
  fetch(aircraftURL)
    .then(res => res.json())
    .then(json => {
      // console.log(json)
      var o = {}
      var timestamp = json['now']
      promises = []
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
	e['distance_km'] = GreatCircle.distance(station_lat, station_long, e['lat'], e['lon'] )
	e['distance_nm'] = GreatCircle.distance(station_lat, station_long, e['lat'], e['lon'], "NM" )
	e['bearing'] = GreatCircle.bearing(station_lat, station_long, e['lat'], e['lon'] )
	var cpa = CPA(0, 0, e['gs'], e['track'], e['distance_nm'], e['bearing'])
	if (cpa) {
         e['cpa_nm'] = cpa[0]
         e['cpa_km'] = cpa[0] * 1.852
         e['cpa_secs'] = cpa[1] * 60
         e['cpa_altitude_estimate'] = e['alt_baro'] + (cpa[1] * e['baro_rate'])
         var cpaPoint = destinationPoint(e['lat'], e['lon'], distanceAfterSeconds(e['gs'], e['cpa_secs']) ,  e['track']);
         e['cpa_lat'] = cpaPoint[0]
         e['cpa_lon'] = cpaPoint[1]
	}
	if (e['hex'] in imgCache) {
	  e['image'] = imgCache[e['hex']]
	} else {
          promises.push(fetch('https://api.planespotters.net/pub/photos/hex/' + e['hex'])
            .then(res => res.json())
            .then(imgJson => {
	      var image = ''
	      if (imgJson['photos'].length > 0) {
	        image = imgJson['photos'][0]['thumbnail']['src']
	      }
              imgCache[e['hex']] = image
	      e['image'] = image
	  }))
	}
	if (e['hex'] in infoCache) {
          e['operator'] = infoCache[e['hex']].operator
          e['owner'] = infoCache[e['hex']].owner
	}
	if (routeDbFile && e['flight']) {
	  if (e['flight'] in routeCache) {
            console.log('Found in cache ' + e['flight'])
	    e['route'] = routeCache[e['flight']]
	  } else {
            console.log('Checking flight ' + e['flight'])
            const re = /^([A-Z]{3})(\d+[^ ]*)/;
            var match = e['flight'].match(re);
            routeCache[e['flight']] = {}
            if (match) {
              sql = "SELECT FromAirportIcao, FromAirportName, FromAirportCountry, FromAirportLocation, " +
	                   "ToAirportIcao, ToAirportName, ToAirportCountry, ToAirportLocation " +
			   "FROM routeview WHERE operatoricao = '" + match[1] + "' and flightnumber = '" + match[2] + "';"
              console.log('Matches: running SQL: ' + sql)
              routeDb.each(sql, (err, row) => {
		data = {
	          'FromIcao': row.FromAirportIcao,
	          'FromName': row.FromAirportName,
	          'FromCountry': row.FromAirportCountry,
	          'FromLocation': row.FromAirportLocation,
	          'ToIcao': row.ToAirportIcao,
	          'ToName': row.ToAirportName,
	          'ToCountry': row.ToAirportCountry,
	          'ToLocation': row.ToAirportLocation,
	          'Source': 'db',
	        }
                console.log('Got data: ' + data);
                routeCache[e['flight']] = data
	        e['route'] = data
	      });
	    } else {
              routeCache[e['flight']] = {}
            }
	  }
	}
      })
      o['nearest_aircraft'].sort(function(a, b) {
	return a['distance_km'] - b['distance_km']
      })

      o['messages_total'] = messages
      if (lasttime > 0 && (timestamp - lasttime) > 0) {
        o['messages_rate'] = (messages - lastmessages) / (timestamp - lasttime)
      }
      lasttime = timestamp
      lastmessages = messages
      o['feeds'] = {}
      if (faJsonURL != "") {
        promises.push(fetch(faJsonURL)
          .then(res => res.json())
	  .then(faJson => {
            // console.log(faJson)
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
            // console.log(frJson)
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
            // console.log(pfJson)
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
	  // console.log(e);
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

client.on('connect', function() {
  if (!routeDbFile) {
      console.log(`No route database provided`)
  } else {
      routeDb = new sqlite3.Database(routeDbFile)
  }
  if (!aircraftDbFile) {
      console.log(`No aircraft database provided`)
      pollUpdate()
  } else {
    var rows = 0;
    fs.createReadStream(aircraftDbFile)
      .pipe(parse({ headers: true }))
      .on('error', error => console.error(error))
      .on('data', row => {
        var record = {'operator': row['operator'], 'owner': row['owner']}
        infoCache[row['icao24']] = record
	rows++;
	if (rows % 10000 == 0) {
          console.log(`Parsed ${rows} aircraft entries`)
	}
      })
      .on('end', rowCount => {
        console.log(`Parsed ${rowCount} rows`)
        pollUpdate()
      });
  }
})

