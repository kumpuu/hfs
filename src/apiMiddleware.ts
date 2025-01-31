// This file is part of HFS - Copyright 2021-2023, Massimo Melina <a@rejetto.com> - License https://www.gnu.org/licenses/gpl-3.0.txt

import Koa from 'koa'
import createSSE from './sse'
import { Readable } from 'stream'
import { asyncGeneratorToReadable, onOff, removeStarting } from './misc'
import events from './events'
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from './const'
import _ from 'lodash'
import { defineConfig } from './config'

export class ApiError extends Error {
    constructor(public status:number, message?:string | Error | object) {
        super(typeof message === 'string' ? message : message && message instanceof Error ? message.message : JSON.stringify(message))
    }
}
type ApiHandlerResult = Record<string,any> | ApiError | Readable | AsyncGenerator<any>
export type ApiHandler = (params:any, ctx:Koa.Context) => ApiHandlerResult | Promise<ApiHandlerResult>
export type ApiHandlers = Record<string, ApiHandler>

const logApi = defineConfig('log_api', true)

export function apiMiddleware(apis: ApiHandlers) : Koa.Middleware {
    return async (ctx) => {
        if (!logApi.get())
            ctx.state.dont_log = true
        const { params } = ctx
        console.debug('API', ctx.method, ctx.path, { ...params })
        const apiFun = apis.hasOwnProperty(ctx.path) && apis[ctx.path]!
        if (!apiFun) {
            ctx.body = 'invalid api'
            return ctx.status = HTTP_NOT_FOUND
        }
        const csrf = ctx.cookies.get('csrf')
        // we don't rely on SameSite cookie option because it's https-only
        let res
        try {
            if (ctx.state.revProxyPath)
                for (const [k,v] of Object.entries(params))
                    if (k.startsWith('uri'))
                        if (typeof v === 'string')
                            fixUri(params, k)
                        else if (typeof (v as any)?.[0] === 'string')
                            (v as string[]).forEach((x,i) => fixUri(v,i))
            res = csrf && csrf !== params.csrf ? new ApiError(HTTP_UNAUTHORIZED, 'csrf')
                : await apiFun(params || {}, ctx)

            function fixUri(o: any, k: string | number) {
                o[k] = removeStarting(ctx.state.revProxyPath, o[k])
            }
        }
        catch(e) {
            res = e
        }
        if (isAsyncGenerator(res))
            res = asyncGeneratorToReadable(res)
        if (res instanceof Readable) { // Readable, we'll go SSE-mode
            res.pipe(createSSE(ctx))
            const resAsReadable = res // satisfy ts
            ctx.req.on('close', () => // by closing the generated stream, creator of the stream will know the request is over without having to access anything else
                resAsReadable.destroy())
            return
        }
        if (res instanceof ApiError) {
            ctx.body = res.message
            return ctx.status = res.status
        }
        if (res instanceof Error) { // generic exception
            ctx.body = res.message || String(res)
            return ctx.status = HTTP_BAD_REQUEST
        }
        ctx.body = res
    }
}

function isAsyncGenerator(x: any): x is AsyncGenerator {
    return typeof (x as AsyncGenerator)?.next === 'function'
}

// offer an api for a generic dynamic list. Suitable to be the result of an api.
type SendListFunc<T> = (list:SendListReadable<T>) => void
export class SendListReadable<T> extends Readable {
    protected lastError: string | number | undefined
    protected buffer: any[] = []
    protected processBuffer: _.DebouncedFunc<any>
    constructor({ addAtStart, doAtStart, bufferTime, onEnd }:{ bufferTime?: number, addAtStart?: T[], doAtStart?: SendListFunc<T>, onEnd?: SendListFunc<T> }={}) {
        super({ objectMode: true, read(){} })
        if (!bufferTime)
            bufferTime = 200
        this.processBuffer = _.debounce(() => {
            this.push(this.buffer)
            this.buffer = []
        }, bufferTime, { maxWait: bufferTime })
        this.on('end', () => {
            onEnd?.(this)
            this.destroy()
        })
        setTimeout(() => doAtStart?.(this)) // work later, when list object has been received by Koa
        if (addAtStart) {
            for (const x of addAtStart)
                this.add(x)
            this.ready()
        }
    }
    protected _push(rec: any) {
        this.buffer.push(rec)
        if (this.buffer.length > 10_000) // hard limit
            this.processBuffer.flush()
        else
            this.processBuffer()
    }
    add(rec: T | T[]) {
        this._push(['add', rec])
    }
    remove(search: Partial<T>) {
        const match = _.matches(search)
        const idx = _.findIndex(this.buffer, x => match(x[1]))
        const found = this.buffer[idx]
        const op = found?.[0]
        if (op === 'remove') return
        if (found) {
            this.buffer.splice(idx, 1)
            if (op === 'add') return
        }
        this._push(['remove', search])
    }
    update(search: Partial<T>, change: Partial<T>) {
        if (_.isEmpty(change)) return
        const match = _.matches(search)
        const found = _.find(this.buffer, x => match(x[1]))
        const op = found?.[0]
        if (op === 'remove') return
        if (op === 'add' || op === 'update')
            return Object.assign(found[op === 'add' ? 1 : 2], change)
        return this._push(['update', search, change])
    }
    ready() { // useful to indicate the end of an initial phase, but we leave open for updates
        this._push(['ready'])
    }
    custom(data: any) {
        this._push(data)
    }
    props(props: object) {
        this._push(['props', props])
    }
    error(msg: NonNullable<typeof this.lastError>, close=false, props?: object) {
        this._push(['error', msg, props])
        this.lastError = msg
        if (close)
            this.close()
    }
    getLastError() {
        return this.lastError
    }
    close() {
        this.processBuffer.flush()
        this.push(null)
    }
    events(ctx: Koa.Context, eventMap: Parameters<typeof onOff>[1]) {
        const off = onOff(events, eventMap)
        ctx.res.once('close', off)
        return this
    }
    isClosed() {
        return this.destroyed
    }
}
