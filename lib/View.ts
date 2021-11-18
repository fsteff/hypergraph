import codecs from 'codecs'
import { Transaction } from 'hyperobjects'
import { Core } from './Core'
import { EdgeTraversingError, VertexLoadingError } from './Errors'
import { Generator} from './Generator'
import { Query } from './Query'
import { IVertex, Vertex } from './Vertex'
import { ViewFactory } from './ViewFactory'
import { QueryState } from './QueryControl'
import { Edge } from '..'

export const GRAPH_VIEW = 'GraphView'
export const STATIC_VIEW = 'StaticView'

export type Codec<T> = string | codecs.BaseCodec<T>
export type VertexQueries<T> = Generator<T>
export type QueryResult<T> = Array<Promise<{result: IVertex<T>, label: string, state?: QueryState<T>}>>

export abstract class View<T> {
    protected readonly transactions: Map<string, Transaction>
    protected readonly codec: Codec<T>
    protected readonly db: Core
    protected readonly factory: ViewFactory<T>
    
    public abstract readonly viewName: string

    constructor(db: Core, contentEncoding: Codec<T>, factory: ViewFactory<T> ,transactions?: Map<string, Transaction>) {
        this.db = db
        this.transactions = transactions || new Map<string, Transaction>()
        this.codec = contentEncoding
        this.factory = factory
    }

    protected async getTransaction(feed: string, version?: number) : Promise<Transaction>{
        let feedId = feed
        if(version) {
            feedId += '@' + version
        }
        if(this.transactions.has(feedId)) {
            return <Transaction>this.transactions.get(feedId)
        }
        else {
            const tr = await this.db.transaction(feed, undefined, version)
            this.transactions.set(feedId, tr)
            return tr
        }
    }

    // TODO: public async get(edge: Edge, state: QueryState) => Promise<{result: IVertex<T>, label: string, state: QueryState<T>}>
    public async get(feed: string|Buffer, id: number, version?: number, viewDesc?: string, metadata?: Object) : Promise<IVertex<T>>{
        feed = Buffer.isBuffer(feed) ? feed.toString('hex') : feed

        if(viewDesc) {
            const view = this.getView(viewDesc)
            return view.get(feed, id, version, undefined, metadata)
                .catch(err => {throw new VertexLoadingError(err, <string>feed, id, version)})
        }

        const tr = await this.getTransaction(feed, version)
        const promise = this.db.getInTransaction<T>(id, this.codec, tr, feed)
        promise.catch(err => {throw new VertexLoadingError(err, <string>feed, id, version, viewDesc)})
        return promise
    }

    protected getView(name?: string): View<T> {
        if(!name) return this
        else return this.factory.get(name, this.transactions)
    }

    /**
     * Default factory for queries, might be overridden by (stateful) View implementations
     * @param startAt Generator of vertices to start from
     * @returns a query
     */
    public query(startAt: VertexQueries<T>): Query<T> {
        return new Query(this, startAt)
    }

    /**
     * The out() function defines the core functionality of a view
     * @param vertex 
     * @param label 
     */
    public abstract out(state: QueryState<T>, label?: string): Promise<QueryResult<T>>

    protected toResult(v: IVertex<T>, edge: Edge, oldState: QueryState<T>): {result: IVertex<T>, label: string, state: QueryState<T>} {
        let newState = oldState
        if(edge.restrictions && edge.restrictions?.length > 0) {
            newState = newState.addRestrictions(v, edge.restrictions)
        }
        return {result: v, label: edge.label, state: newState}
    }

    
}

export class GraphView<T> extends View<T> {
    public readonly viewName = GRAPH_VIEW

    constructor(db: Core, contentEncoding: Codec<T>, factory: ViewFactory<T>, transactions?: Map<string, Transaction>){
        super(db, contentEncoding, factory, transactions)

    }

    public async out(state: QueryState<T>, label?: string): Promise<QueryResult<T>> {
        const vertex = <Vertex<T>> state.value
        if(typeof vertex.getId !== 'function' || typeof vertex.getFeed !== 'function' || !vertex.getFeed()) {
            throw new Error('GraphView.out does only accept persisted Vertex instances as input')
        }
        const edges = vertex.getEdges(label)
        const vertices: QueryResult<T> = []
        for(const edge of edges) {
            const feed =  edge.feed?.toString('hex') || <string>vertex.getFeed()
            // TODO: version pinning does not work yet
            const promise = this.get(feed, edge.ref, /*edge.version*/ undefined, edge.view, edge.metadata).then(v => this.toResult(v, edge, state))
            promise.catch(err => {throw new EdgeTraversingError({id: vertex.getId(), feed: <string>vertex.getFeed()}, edge, new Error('key is ' + edge.metadata?.['key']?.toString('hex').substr(0,2) + '...'))})
            vertices.push(promise)
        }
        return vertices
    }
}

export class StaticView<T> extends View<T> {
    public readonly viewName = STATIC_VIEW

    constructor(db: Core, contentEncoding: Codec<T>, factory: ViewFactory<T>, transactions?: Map<string, Transaction>){
        super(db, contentEncoding, factory, transactions)
    }

    public async out(state: QueryState<T>, label?: string):  Promise<QueryResult<T>> {
        const vertex = <Vertex<T>> state.value
        if(typeof vertex.getId !== 'function' || typeof vertex.getFeed !== 'function' || !vertex.getFeed()) {
            throw new Error('GraphView.out does only accept persisted Vertex instances as input')
        }
        const edges = vertex.getEdges(label)
        const vertices: QueryResult<T> = []
        for(const edge of edges) {
            const feed =  edge.feed?.toString('hex') || <string>vertex.getFeed()
            // TODO: version pinning does not work yet
            const promise = this.get(feed, edge.ref).then(v => this.toResult(v, edge, state))
            promise.catch(err => {throw new EdgeTraversingError({id: vertex.getId(), feed: <string>vertex.getFeed()}, edge, new Error('key is ' + edge.metadata?.['key']?.toString('hex').substr(0,2) + '...'))})
            vertices.push(promise)
        }
        return vertices
    }

    // ignores other views in metadata
    public async get(feed: string|Buffer, id: number, version?: number) : Promise<IVertex<T>>{
        feed = Buffer.isBuffer(feed) ? feed.toString('hex') : feed

        const tr = await this.getTransaction(feed, version)
        const promise = this.db.getInTransaction<T>(id, this.codec, tr, feed)
        promise.catch(err => {throw new VertexLoadingError(err, <string>feed, id, version)})
        return promise
    }

}