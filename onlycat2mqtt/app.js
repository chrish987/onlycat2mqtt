'use strict';

const SocketIO = require('socket.io-client');
const mqtt = require('mqtt');
const winston = require('winston');
const moment = require('moment');

const VERSION = 0.1;
const LOG_LEVEL = process.env.LOG_LEVEL;
const TOKEN = process.env.TOKEN;
const MQTT_SERVER = process.env.MQTT_SERVER;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const EVENT_TRIGGER_SOURCE = {
	0: 'MANUAL',
	1: 'REMOTE',
	2: 'INDOOR_MOTION',
	3: 'OUTDOOR_MOTION'
};

const EVENT_CLASSIFICATION = {
	0: 'UNKNOWN',
	1: 'CLEAR',
	2: 'SUSPICIOUS',
	3: 'CONTRABAND',
	4: 'HUMAN_ACTIVITY',
	10: 'REMOTE_UNLOCK',
};

let saveddevices = [];
let savedrfids = [];

const logFormat = winston.format.printf(({ level, message, timestamp }) => {
	const formattedTimestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS'); 
	return `${formattedTimestamp} [${level}] ${message}`;
});

const logger = winston.createLogger({
	level: LOG_LEVEL,
	format: logFormat,
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'log/onlycat.log' })
	]
});

logger.info("Starting Onlycat Websocket to MQTT. Version: " + VERSION);
logger.info("Configured Timezone: " + Intl.DateTimeFormat().resolvedOptions().timeZone);

const client = mqtt.connect(MQTT_SERVER, {
	username: MQTT_USERNAME,
	password: MQTT_PASSWORD
});

let socket = SocketIO.io('https://gateway.onlycat.com', {
	transports: ['websocket'],
	query: {
		platform: 'onlycat2mqtt',
		device: 'ionic-app'
	},
	auth: (async (cb) => {
		cb({
			token: TOKEN
		});
	})
});

socket.on('connect', () => {
	logger.info(`Socket connected.`);
	getConfigData();

});
socket.io.on('reconnect', () => {
	logger.info(`Socket attempting to reconnect.`);
});
socket.on('disconnect', (reason) => {
	logger.warn(`Socket disconnected: ` + reason);
});
socket.on('userUpdate', (event) => {
	logger.info("User [" + event.name + "] with Id [" + event.id + "] logged in.");
	logger.debug(`UserUpdate: '${JSON.stringify(event)}'`);
});
socket.on('userEventUpdate', (event) => {
	logger.debug(`userEventUpdate: '${JSON.stringify(event)}'`);
	//handleEventUpdate('userEventUpdate', event);
});
socket.on('userDeviceUpdate', (event) => {
	logger.debug(`userDeviceUpdate: '${JSON.stringify(event)}'`);
});
socket.on('deviceUpdate', (event) => {
	logger.debug(`deviceUpdate: '${JSON.stringify(event)}'`);
});
socket.on('deviceEventUpdate', (event) => {
	handleEventUpdate('deviceEventUpdate', event);
});
socket.on('eventUpdate', (event) => {
	handleEventUpdate('eventUpdate', event);
});

client.on('connect', () => {
	logger.info("Connected to MQTT broker.");
});

client.on('error', (error) => {
	logger.info("MQTT Client Error: " + error);
});

logger.on('finish', () => {
	process.exit(0);
});

process.on('exit', (code) => {
	logger.info("Exited.");
});
process.on('SIGINT', (code) => {
	socket.disconnect(true);
	logger.info("SIGINT recieved. Cleaning up.");
});
process.on('SIGTERM', (code) => {
	socket.disconnect(true);
	logger.info("SIGTERM recieved. Cleaning up.");
});
process.on('uncaughtException', (error, origin) => {
	socket.disconnect(true);
	logger.info("Unhandled Exception. Error: [" + error + "] Origin: [" + origin + "] - Cleaning up.");
});

async function handleEventUpdate(eventType, eventData) {
	try {
		let eventDetails = await getEvent(eventData.deviceId, eventData.eventId);
		logger.debug(JSON.stringify(eventDetails));
		let mqttMsg = {};
		mqttMsg.eventtime = moment(eventDetails.timestamp).format();
		mqttMsg.eventid = eventData.eventId;
		mqttMsg.type = eventData.type;
		mqttMsg.deviceid = eventDetails.deviceId;
		for (let device_element of saveddevices) {
			if (device_element.deviceId == eventDetails.deviceId) {
				mqttMsg.devicename = device_element.description;
				break;
			}
		}
		mqttMsg.triggersource = EVENT_TRIGGER_SOURCE[eventDetails.eventTriggerSource];
		mqttMsg.classification = EVENT_CLASSIFICATION[eventDetails.eventClassification];
		let rfidcodes = [];
		for (let detected_rfid_element of eventDetails.rfidCodes) {
			let rfidcode = {};
			rfidcode.tag = detected_rfid_element;
			for (let saved_rfid_element of savedrfids) {
				if (saved_rfid_element.rfidCode == detected_rfid_element) {
					rfidcode.name = saved_rfid_element.label;
					break;
				}
			}
			rfidcodes.push(rfidcode);
		}
		mqttMsg.rfidcodes = rfidcodes;
		mqttMsg.captureurl = "https://gateway.onlycat.com/sharing/video/" + eventDetails.deviceId + "/" + eventDetails.eventId + "?t=" + eventDetails.accessToken;
		mqttMsg.framecount = eventDetails.frameCount;
		mqttMsg.accesstoken = eventDetails.accessToken;

		logger.info("Recieved event. Event ID [" + eventData.eventId + "] type [" + eventType + "].");
		logger.debug("Event Type: " + eventType);
		logger.debug("Event Data: " + JSON.stringify(eventData));
		logger.debug("Event Details: " + JSON.stringify(eventDetails));
		logger.debug("Sent MQTT Message: " + JSON.stringify(mqttMsg));

		client.publish('onlycat2mqtt/event', JSON.stringify(mqttMsg));
	}
	catch {

	}
}

async function getConfigData() {

	//empty the arrays and start again - mainly for a reconnect.
	saveddevices.length = 0;
	savedrfids.length = 0;

	//Get the devices - RFID and Policies are per device
	logger.info("Retrieving Devices (flaps) from API.");
	let devices = await getDevices();
	logger.info("Found " + devices.length + " Device(s) (flaps).");

	for (let device_element of devices) {
		let device = await getDevice(device_element.deviceId);
		saveddevices.push(device);
		logger.info("Added Device (flap) [" + device_element.deviceId + "] with description [" + device.description + "] to saved Devices.");

		//get the RFID tags from the device
		logger.info("Retrieving RFID tags for Device [" + device_element.deviceId + "] from API.");
		let rfids = await getRfids(device_element.deviceId);
		logger.info("Found " + rfids.length + " RFID tags for Device [" + device_element.deviceId + "].");
		for (let rfid_element of rfids) {
			let rfidprofile = await getRfidProfile(rfid_element.rfidCode);
			let rfidalreadyexists = false;
			for (let savedrfid_element of savedrfids) {
				if (rfid_element.rfidCode == savedrfid_element.rfidCode) {
					rfidalreadyexists = true;
					logger.info("Skipped RFID tag [" + savedrfid_element.rfidCode + "] RFID tag already exists in saved RFID tags (likely from another device).");
					break;
				}
			}
			if (rfidalreadyexists == false) {
				let newrfid = new Object();
				newrfid.rfidCode = rfid_element.rfidCode;
				newrfid.label = rfidprofile.label;
				savedrfids.push(newrfid);
				logger.info("Added RFID tag [" + newrfid.rfidCode + "] with label [" + rfidprofile.label + "] to saved RFID tags.");
			}
		}
		logger.debug(savedrfids);
		logger.info("Finished retrieving RFID tags from API.");

		//get the Transit Policies from the device
		let transitpolicies = await getDeviceTransitPolicies(device_element.deviceId);
		//console.log(transitpolicies);
		for (let transitpolicies_element of transitpolicies) {
			let transitpolicy = await getDeviceTransitPolicy(transitpolicies_element.deviceTransitPolicyId);
			//console.log(transitpolicy)
			//console.log(transitpolicy.transitPolicy.rules);
		}
		let deviceevents = await getDeviceEvents(device_element.deviceId);
		logger.info("Retrieved " + deviceevents.length + " saved events from device [" + device_element.deviceId + "].");
		//console.log(deviceevents);

	}
}

async function getDevices() {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getDevices', { subscribe: true }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getDevices function");
	}
}

async function getDevice(deviceId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getDevice', { subscribe: true, deviceId: deviceId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getDevice function");
	}
}

async function getRfids(deviceId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getLastSeenRfidCodesByDevice', { deviceId: deviceId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getRfids function");
	}
}

async function getRfidProfile(rfidCode) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getRfidProfile', { rfidCode: rfidCode }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getRfidProfile function");
	}
}

async function getDeviceTransitPolicies(deviceId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getDeviceTransitPolicies', { deviceId: deviceId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getDeviceTransitPolicies function");
	}
}

async function getDeviceTransitPolicy(deviceTransitPolicyId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getDeviceTransitPolicy', { deviceTransitPolicyId: deviceTransitPolicyId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getDeviceTransitPolicy function");
	}
}

async function getEvents() {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getEvents', { subscribe: true }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getEvents function");
	}
}

async function getDeviceEvents(deviceId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getDeviceEvents', { subscribe: true, deviceId: deviceId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getDeviceEvents function");
	}
}

async function getEvent(deviceId, eventId) {
	try {
		return new Promise((resolve, reject) => {
			socket.emit('getEvent', { subscribe: true, deviceId: deviceId, eventId: eventId }, (response) => {
				if (response.error) {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});
	}
	catch {
		logger.error("Error in getEvent function");
	}
}
