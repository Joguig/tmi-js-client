package {

import flash.display.Sprite;
import flash.events.DataEvent;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.SecurityErrorEvent;
import flash.events.TimerEvent;
import flash.external.ExternalInterface;
import flash.net.XMLSocket;
import flash.system.Security;
import flash.utils.Timer;

public class JSSocket extends Sprite {

    public static const MAX_BUFFER_SIZE:int = 1000;

    private var _eventsCallback:String;
    private var _clientId:String;

    private var _socket:XMLSocket;
    private var _msgRateCalc:MessageRateCalc;
    private var _lastMsgRate:int;
    private var _eventsLoopCount:int;
    private var _eventsTimer:Timer;
    private var _eventsBuffer:Array;
    private var _dataBuffer:Array;
    private var _numOverflows:int;

    // Build instructions:
    // cd client
    // mxmlc -target-player 10.1 -compiler.debug -output assets/JSSocket.swf src/JSSocket.as
    public function JSSocket() {
        //trace("Initializing JSSocket...");
        Security.allowDomain("*");

        _eventsCallback = loaderInfo.parameters.eventsCallback;
        _clientId = loaderInfo.parameters.clientId;

        // Protect ourselves against XSS attacks.
        // Any ExternalInterface.call that has function or parameters specified
        // by the user is vulnerable to XSS. Because this SWF is hosted by
        // twitch.tv, it has access to twitch.tv cookies and avoids cross-origin
        // request protection.
        if (_eventsCallback !== "_flashSocket.eventsCallback") {
            throw new Error("invalid eventsCallback");
        }
        if (/^[0-9]+$/.exec(_clientId) === null) {
            throw new Error("invalid clientId");
        }

        _socket = new XMLSocket();
        addSocketEventListeners();

        ExternalInterface.addCallback("connect", connect);
        ExternalInterface.addCallback("close", close);
        ExternalInterface.addCallback("send", send);

        _msgRateCalc = new MessageRateCalc(60);
        _lastMsgRate = 0;

        _numOverflows = 0;
        _dataBuffer = [];
        _eventsBuffer = [{
            event: "data_buffer",
            buffer: _dataBuffer
        }];

        _eventsLoopCount = 0;
        _eventsTimer = new Timer(100);
        _eventsTimer.addEventListener(TimerEvent.TIMER, onEventsTimer, false, 0, true);
        _eventsTimer.start();

        ExternalInterface.call(_eventsCallback, _clientId, [{event: "loaded"}]);
    }

    private function connect(host:String, port:int):void {
        try {
            //trace("socket.connect(" + host + ", " + port + ")");
            _socket.connect(host, port);
        } catch (err:*) {
            trigger({
                event: "exception",
                method: "connect",
                message: err.toString()
            });
        }
    }

    private function close():void {
        try {
            //trace("socket.close()");
            _socket.close();
            trigger({
                event: "closed"
            });
        } catch (err:*) {
            trigger({
                event: "exception",
                method: "close",
                message: err.toString()
            });
        }
    }

    private function send(data:String, appendNullByte:Boolean):void {
        try {
            //trace("socket.send(" + data + ", " + appendNullByte + ")");
            if (appendNullByte) {
                data += String.fromCharCode(0);
            }
            _socket.send(data);
        } catch (err:*) {
            trigger({
                event: "exception",
                method: "send",
                message: err.toString()
            });
        }
    }

    private function onEventsTimer(timerEvent:TimerEvent):void {
        if (_eventsLoopCount % 10 == 0) {
            _eventsLoopCount = 0;
            // This timer is triggered every 100ms, so on every 10th iteration (every 1s) we should pass
            // the message rate to JS
            var oldMsgRate:int = _lastMsgRate;
            _lastMsgRate = _msgRateCalc.rate();
            if (_lastMsgRate != oldMsgRate) {
                _eventsBuffer.push({
                    event: 'stats',
                    stats: {
                        dataRate: _lastMsgRate,
                        overflows: _numOverflows
                    }
                });
            }
        }
        _eventsLoopCount += 1;

        // eventBuffer always has one event (data_buffer) so we don't need to trigger the
        // event callback if that one event has no data in it
        if (_dataBuffer.length > 0 || _eventsBuffer.length > 1) {
            var oldBuffer:Array = _eventsBuffer;
            _dataBuffer = [];
            _eventsBuffer = [{
                event: "data_buffer",
                buffer: _dataBuffer
            }];
            ExternalInterface.call(_eventsCallback, _clientId, oldBuffer);
        }
    }

    private function trigger(event:Object):void {
        _eventsBuffer.push(event);
    }

    private function onSocketConnect(event:Event):void {
        //trace("socket connected");
        trigger({
            event: "connected"
        });
    }

    private function onSocketClose(event:Event):void {
        //trace("socket closed");
        trigger({
            event: "closed"
        });
    }

    private function onSocketData(dataEvent:DataEvent):void {
        _msgRateCalc.add();
        if (_dataBuffer.length < MAX_BUFFER_SIZE) {
            // Encoding the data prevents JS from interpretting escape sequences (e.g. "\r\n").
            _dataBuffer.push(encodeURIComponent(dataEvent.data));
        } else {
            _numOverflows++;
        }
    }

    private function onSocketIOErrorEvent(ioErrorEvent:IOErrorEvent):void {
        //trace("socket io error");
        trigger({
            event: "error",
            type: "io",
            message: ioErrorEvent.toString()
        })
    }

    private function onSocketSecurityErrorEvent(securityErrorEvent:SecurityErrorEvent):void {
        //trace("socket security error");
        trigger({
            event: "error",
            type: "security",
            message: securityErrorEvent.toString()
        })
    }

    private function addSocketEventListeners():void {
        _socket.addEventListener(Event.CONNECT, onSocketConnect);
        _socket.addEventListener(Event.CLOSE, onSocketClose);
        _socket.addEventListener(DataEvent.DATA, onSocketData);
        _socket.addEventListener(IOErrorEvent.IO_ERROR, onSocketIOErrorEvent);
        _socket.addEventListener(SecurityErrorEvent.SECURITY_ERROR, onSocketSecurityErrorEvent);
    }

}

}

class MessageRateCalc {

    private var _initSecond:int;
    private var _numSeconds:int;
    private var _rollingDataBufferCounts:Array;
    private var _rollingDataBufferSeconds:Array;

    private var _oldestSecond:int;
    private var _mostRecentSecond:int;

    private var _latestCachedRate:int;
    private var _latestCachedSecond:int;

    public function MessageRateCalc(numSeconds:int) {
        _initSecond = getCurrentSecond();
        _numSeconds = numSeconds;
        _rollingDataBufferSeconds = [];
        _rollingDataBufferCounts = [];

        _oldestSecond = 0;
        _mostRecentSecond = 0;

        _latestCachedRate = 0;
        _latestCachedSecond = 0;
    }

    public function add():void {
        var currentSecond:int = getCurrentSecond();
        if (_mostRecentSecond != currentSecond) {
            if (_oldestSecond > 0 && _oldestSecond < (currentSecond - _numSeconds)) {
                _rollingDataBufferSeconds = _rollingDataBufferSeconds.slice(1);
                _rollingDataBufferCounts = _rollingDataBufferCounts.slice(1);
            }
            _rollingDataBufferSeconds.push(currentSecond);
            _rollingDataBufferCounts.push(0);
            _mostRecentSecond = currentSecond;
            _oldestSecond = _rollingDataBufferSeconds[0];
        }
        _rollingDataBufferCounts[_rollingDataBufferSeconds.length - 1] += 1;
    }

    public function rate():int {
        var currentSecond:int = getCurrentSecond();
        if (currentSecond != _latestCachedSecond) {
            var numMessages:int = 0;
            var oldestRelevantSecond:int = currentSecond - _numSeconds;
            for (var i:int = 0; i < _rollingDataBufferSeconds.length; i++) {
                if (_rollingDataBufferSeconds[i] >= oldestRelevantSecond && _rollingDataBufferSeconds[i] < currentSecond) {
                    numMessages += _rollingDataBufferCounts[i];
                }
            }
            _latestCachedRate = Math.round(numMessages / Math.min(_numSeconds, currentSecond - _initSecond));
            _latestCachedSecond = currentSecond;
        }
        return _latestCachedRate;
    }

    private function getCurrentSecond():int {
        return Math.floor(new Date().getTime() / 1000);
    }

}
