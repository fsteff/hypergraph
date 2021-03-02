import { Core, DBOpts, Corestore } from './lib/Core'
import { Codec, SimpleGraphObject, GraphObject } from './lib/Codec'
import { Edge, Vertex } from './lib/Vertex'
import Crawler from './lib/Crawler'
import { Index } from './lib/Index'
import { Query, VertexQuery } from './lib/Query'
import { Transaction } from 'hyperobjects'
import { Generator } from './lib/Generator'
import * as Errors from './lib/Errors'

export {Vertex, GraphObject, Index, SimpleGraphObject, Core, Corestore, Query, Crawler, Generator, Errors}
export class HyperGraphDB {
    readonly core: Core
    readonly crawler: Crawler
    readonly codec = new Codec()

    constructor(corestore: Corestore, key?: string | Buffer, opts?: DBOpts, customCore?: Core) {
        this.core = customCore || new Core(corestore, key, opts)
        this.codec.registerImpl(data => new SimpleGraphObject(data))
        this.crawler = new Crawler(this.core)
    }

    async put(vertex: Vertex<GraphObject> | Array<Vertex<GraphObject>>, feed?: string | Buffer) {
        feed = feed || await this.core.getDefaultFeedId()
        if(Array.isArray(vertex)) {
            return await this.core.putAll(feed, vertex)
        } else {
            return await this.core.put(feed, vertex)
        }
    }

    async get(id: number, feed?: string | Buffer) : Promise<Vertex<GraphObject>>{
        feed = feed || await this.core.getDefaultFeedId()
        return await this.core.get<GraphObject>(feed, id, this.codec)
    }

    get indexes () {
        return this.crawler.indexes
    }

    create<T extends GraphObject>() : Vertex<T> {
        return <Vertex<T>> new Vertex<GraphObject>(this.codec)
    }

    queryIndex(indexName: string, key: string) {
        const idx = this.indexes.find(i => i.indexName === indexName)
        if(!idx) throw new Error('no index of name "' + indexName + '" found')

        const vertices = new Array<VertexQuery<GraphObject>>()
        const transactions = new Map<string, Transaction>()
        for(const {id, feed} of idx.get(key)) {
            let tr: Promise<Transaction>
            if(!transactions.has(feed)) {
                tr = this.core.transaction(feed)
                tr.then(tr => transactions.set(feed, tr))
            } else {
                tr = Promise.resolve(<Transaction> transactions.get(feed))
            }
            const promise = tr.then(tr => this.core.getInTransaction<GraphObject>(id, this.codec, tr, feed))
            vertices.push({feed, vertex: promise})
        }
        return new Query<GraphObject>(this.core, Generator.from(vertices), transactions, this.codec)
    }

    queryAtId(id: number, feed: string|Buffer) {
        const transactions = new Map<string, Transaction>()
        feed = <string> (Buffer.isBuffer(feed) ? feed.toString('hex') : feed)
        const trPromise = this.core.transaction(feed)
        const vertex = trPromise.then(tr => {
            const v = this.core.getInTransaction<GraphObject>(id, this.codec, tr, <string>feed)
            transactions.set(<string>feed, tr)
            return v
        })
        
        return new Query<GraphObject>(this.core, Generator.from([{feed, vertex}]), transactions, this.codec)
    }

    queryAtVertex(vertex: Vertex<GraphObject>) {
        return this.queryAtId(vertex.getId(), <string> vertex.getFeed())
    }

    queryPathAtVertex<T extends GraphObject>(path: string, vertex: Vertex<T>) {
        const parts = path.replace(/\\/g, '/').split('/').filter(s => s.length > 0)
        let last = this.queryAtVertex(vertex)
        for(const next of parts) {
            last = last.out(next)
        }
        return last
    }

    async createEdgesToPath<T extends GraphObject, K extends GraphObject>(path: string, root: Vertex<K>) {
        const self = this
        const parts = path.replace(/\\/g, '/').split('/').filter(s => s.length > 0)
        if(!root.getWriteable()) throw new Error('passed root vertex has to be writeable')
        const tr = <Transaction> await this.core.transaction(<string>root.getFeed())
        const feed = tr.store.key

        const created = new Array<Vertex<T>>()
        const route = new Array<{parent: Vertex<any>, child: Vertex<any>, label: string}>()
        for (const next of parts) {
            let current
            const edges = root.getEdges(next).filter(e => !e.feed || e.feed.equals(feed))
            const vertices = await Promise.all(getVertices(edges))
            if(vertices.length === 0) {
                current = this.create<T>()
                created.push(current)
                route.push({parent: root, child: current, label: next})
            } else if (vertices.length === 1) {
                current = vertices[0]
            } else {
                current = vertices.sort(newest)[0]
            }
            root = current
        }

        await this.put(created, feed)
        const changes = new Array<Vertex<any>>()
        for(const v of route) {
           v.parent.addEdgeTo(v.child, v.label)
           changes.push(v.parent)
        }
        await this.put(changes, feed)
        return created
       
        function getVertices(edges: Edge[]) {
            return edges.map(e => self.core.getInTransaction(e.ref, 'binary', tr, feed.toString('hex') ))
        }

        function newest(a: Vertex<any>, b: Vertex<any>) {
            return (b.getTimestamp() || 0) - (a.getTimestamp() || 0)
        }
    }
}
