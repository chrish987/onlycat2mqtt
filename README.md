# onlycat2mqtt

Simple Node.js program that subscribes to Onlycat's websocket in the cloud, listens for events and then sends to an MQTT server.

I use this for my own Home Automation integration.

It will download devices and RFID tags/names from the Onlycat cloud when started. All this is just stored in memory.

Should be as simple as:
1. Clone the repository
2. Fill in ENV variables in docker-compose.yml
3. docker compose up -d

Find the TOKEN in the Account section of the Onlycat app under Device Token.

Generally each event will generate 4 messages:
First message comes more or less immediately on detecting activity, will just show if motion is detected from inside or outside.
Second message adds motion classification.
Third message adds detected RFID tags.
Fourth message is video file is ready and with a framecount.

