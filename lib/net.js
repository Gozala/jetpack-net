const { Cc, Ci, components } = require("chrome")
const CC = components.Constructor
const { EventEmitter } = require('./events')

const { ByteReader, ByteWriter } = require('byte-streams')
const { TextReader, TextWriter } = require('text-streams')
const unload = require('unload')

const SocketServer = CC("@mozilla.org/network/server-socket;1", "nsIServerSocket", "init")
const TransportSevice = Cc["@mozilla.org/network/socket-transport-service;1"].
    getService(Ci.nsISocketTransportService)
const Pump = CC("@mozilla.org/network/input-stream-pump;1", "nsIInputStreamPump", "init")
const SocketTranport = Ci.nsISocketTransport

const
    BACKLOG = -1
const
    CONNECTING = 'opening',  // 0 The connection has not yet been established
    OPEN  = 'open',          // 1 Socket connection is established and communication is possible
    CLOSED = 'closed',       // 2 The connection has been closed or could not be opened
    READ = 'readOnly',
    WRITE = 'writeOnly'

let GUID = 0
const
    streams = {},
    servers = {}

unload.ensure({ 
    unload: function() {
        for each(let server in servers) {
            server._removeAllListeners()
            server.close()
        }
        for each(let stream in streams) stream.destroy()
    }
})

exports.createConnection = function (port, host) {
    let stream = new Stream()
    stream.connect(port, host)
    return stream
}
exports.Stream = Stream
function Stream() {
    let stream = { 
        __proto__: Stream.prototype,
        _guid: ++ GUID
    }
    stream.on('readyState', function(state) {
    })
    streams[stream._guid] = stream
    return stream
}
Stream.prototype = {
    __proto__: EventEmitter.prototype,
    constructor: Stream,
    _encoding: null,
    _resolving: null,
    _readable: null,
    _writable: null,
    _port: null,
    _host: null,
    _readers: null,
    _writers: null,
    
    _transport: null,
    _rawInput: null,
    _rawOutput: null,
    
    get host() this._transport.host,
    get port() this._transport.port,
    get encoding() this._encoding,
    get readable() this._readable,
    get writable() this._writable,
    get readyState() {
        if (this._resolving) return CONNECTING
        else if (this._readable && this._writable) return OPEN
        else if (this._readable && !this._writable) return READ
        else if (!this._readable && this._writable) return WRITE
        else return CLOSED
    },
    
    get remoteAddress() this.host + ':' + this.port,
    
    setEncoding: function setEncoding(value) this._encoding = value,
    
    _lastState: null,
    _stateChange: function _stateChange() {
        let state = this.readyState
        if (this._lastState != state) {
            this._emit('readyState', this._lastState = state)
            switch (state) {
                case CONNECTING:
                    break
                case OPEN:
                    this._emit('connect')
                    break
                case WRITE:
                    this._emit('end')
                    break
                case READ:
                    break
                case CLOSED:
                    this._emit('close')
                    break
            }
        }
    },
    _ended: function _ended() {
        this._readable = this._writable = false
        this._stateChange()
    },
    open: function open() {
        try {
            throw new Error('Not yet implemented')
        } catch(e) {
            this._emit('error', e)
            this.destroy()
        }
    },
    connect: function connect(port, host) {
        try {
            this._transport = TransportSevice.
                createTransport(null, 0, host, port, null)
            this._connect()
        } catch(e) {
            this._emit('error', e)
            this.destroy()
        }
    },
    _connect: function _connect() {
        let stream = this
        let transport = this._transport
        stream._rawOutput = transport.openOutputStream(0, 0, 0)
        stream._rawInput = transport.openInputStream(0, 0, 0)
        transport.setEventSink({
            onTransportStatus: function(transport, status, progress, total) {
                let state = stream.readyState
                switch (status) {
                    case SocketTranport.STATUS_RESOLVING:
                        break
                    case SocketTranport.STATUS_CONNECTING_TO:
                        stream._resolving = true
                        break
                    case SocketTranport.STATUS_CONNECTED_TO:
                        stream._resolving = false
                        stream._readable = true
                        stream._writable = true
                        break
                    case SocketTranport.STATUS_SENDING_TO:
                        break
                    case SocketTranport.STATUS_WAITING_FOR:
                        break
                    case SocketTranport.STATUS_RECEIVING_FROM:
                        break
                }
                stream._stateChange()
            }
        }, null)
        new Pump(stream._rawInput, -1, -1, 0, 0, false).asyncRead({
            // Called to signify the beginning of an asynchronous request.
            onStartRequest: function(request, context) {},
            // Called to signify the end of an asynchronous request.
            onStopRequest: function(request, context, status) stream._ended(),
            // Called when the next chunk of data (corresponding to the
            // request) may be read without blocking the calling thread.
            onDataAvailable: function(request, context, strm, offset, count)
                stream._read(count)
        }, null)
    },
    _read: function _read(count) {
        try {
            let encoding = this._encoding
            let readers = this._readers || (this._readers = {})
            let reader = readers[encoding]
            if (!reader) reader = readers[encoding] = 
                new (null === encoding ? ByteReader : TextReader)
                (this._rawInput, encoding)
            this._emit('data', reader.read(count))
        } catch(e) {
            this._emit('error', e)
            this.destroy(e)
        }
    },
    /**
        
    */
    write: function write(buffer, encoding) {
        try {
            let writers = this._writers || (this._writers = {})
            let writer = writers[encoding]
            if (!writer)  writer = writers[encoding] = 
                new (null === encoding ? ByteWriter : TextWriter)
                (this._rawOutput, encoding)
            writer.write(buffer)
        } catch(e) {
            this._emit('error', e)
            this.destroy()
        }
    },
    end: function end() {
        try {
            this._readable = false
            let readers = this._readers
            for (let key in readers) {
                readers[key].close()
                delete readers[key]
            }
            this._writable = false
            let writers = this._writers
            for (let key in writers) {
                writers[key].close()
                delete writers[key]
            }
            this._transport.close(0)
            this._stateChange()
        } catch(e) {
            this._emit('error', e)
            this.destroy(e)
        }
    },
    destroy: function destroy() {
        this._removeAllListeners()
        this.end()
        delete this._rawInput
        delete this._rawOutput
        delete this._transport
        delete streams[this._guid]
    }
}

exports.createServer = function (listener) new Server(listener)

exports.Server = Server
function Server(listener) {
    let server = { __proto__: Server.prototype, _guid: ++ GUID }
    if (listener) server.on('connection', listener)
    return server
}
Server.prototype = {
    __proto__: EventEmitter.prototype,
    constructor: Server,
    type: null,
    loopbackOnly: false,
    /**
        Stops the server from accepting new connections. This function is
        asynchronous, the server is finally closed when the server emits a
        'close' event.
    */
    close: function() {
        this._server.close()
        delete servers[this._guid]
    },
    listen: function(port, host, callback) {
        try {
            if (this.fd) throw new Error('Server already opened');
            if (!callback) [callback, host] = [host, callback]
            if (callback) this.on('listening', callback)
            if (isPort(port)) {
                this.type = 'tcp'
                let self = this
                let server = this._server = 
                    new SocketServer(port, this.loopbackOnly, BACKLOG)
                server.asyncListen({
                    onSocketAccepted: function(server, transport) {
                        try {
                            let stream = Stream()
                            stream._transport = transport
                            stream._readable = true
                            stream._writable = true
                            stream.server = self
                            stream._connect()
                            /*
                            let stream = Stream.create({
                                _readable: true,
                                _writable: true,
                                _transport: transport,
                                _init: function() {
                                    Stream.prototype._init.call(this)
                                    this._connect()
                                }
                            })
                            */
                            self._emit('connection', stream)
                            
                        } catch (e) {
                            self._emit('error', e)
                        }
                    },
                    onStopListening: function(server, socket)
                        self._emit('close')
                })
            }
            this._emit('listening')
        } catch(e) {
            this._emit('error', e)
        }
    }
}

function isPort(x) parseInt(x) >= 0
