/**
 * Node
 */

import { promisify } from 'util'
require('dotenv').config()

/**
 * YouTube
 */
const ytdl = require('ytdl-core')
const ytSearch = require('youtube-search')
const youtubeOptions = {
  maxResults: 1,
  key: process.env.YOUTUBE_API_KEY
}

/**
 * Redis DB
 */

const redis = require('redis')

/**
 * Cache options
 * EXPIRE_SECONDS - Set this according to desired performance and limitations
 * MAX_QUERY_LENGTH - Max YouTube search query length (truncate)
 */
 
enum CacheOptions {
  EXPIRE_SECONDS = (60 * 60 * 24 * 7),
  MAX_QUERY_LENGTH = 128
}

/**
 * Basic incremental stat tracking
 */

interface CacheStats {
  cacheHits: number,
  fetchCount: number,
  errorCount: number
}

module.exports = class YTSearchCache {
  private _client: any
  private _getAsyncFromDB: Function
  private _stats: CacheStats

  constructor () {
	/**
     * Track cache hit, fetch and error count for given instance
     */
    this._stats = {
      cacheHits: 0,
      fetchCount: 0,
      errorCount: 0
    }

    try {
      this._client = redis.createClient()
      this._log('Connected')
    } catch (err) {
      this._log(`${err.message}`)
    }

    this._client.on('error', err => this._log(`Error ${err}`))

    /**
     * Promisify redis GET so we can use async/await
     */
    this._getAsyncFromDB = promisify(this._client.get).bind(this._client)
  }

  private _log (input: string) {
    console.log(`Redis: ${input}`)
  }

  public getStats(): CacheStats {
    return this._stats
  }

  
  public getSongInfo (input: string) : object {
    /**
     * Normalize the query by trimming, converting
     * to lowercase and truncate to max length
     */
    const query: string = input.trim()
    .toLowerCase()
    .substr(0, CacheOptions.MAX_QUERY_LENGTH)
    
    /**
     * Return a promise as DB retrieve and API fetch
     * are both async, so we can await on this
     */
    return new Promise(async (resolve, reject) => {
      let info: object

      this._log(`GET "${query}"`)
      /**
       * Try to retrieve from redis. _get
       */
      try {
        const cachedInfo = await this._getAsyncFromDB(query)
        if (cachedInfo) {
          ++this._stats.cacheHits
          this._log('Cache hit')
  
          /**
           * Deserialize and return
           */
          return resolve(JSON.parse(cachedInfo))
        }
      } catch (err) {
        /**
         * Cache retrieve shouldn't throw, so reject if it does
         */
        ++this._stats.errorCount
        return reject(err)
      }

      this._log('No cache hit, fetching')

      /**
       * Check if the the query is a YouTube URL, if not, search for it
       */
      const youTubeURLRegex = /^(https?\:\/\/)?(www\.)?(m\.)?(youtube\.com|youtu\.?be)\/.+$/

      if (query.match(youTubeURLRegex)) {
        try {
          info = await ytdl.getInfo(query)
        } catch (err) {
          ++this._stats.errorCount
          return reject(err)
        }
      } else {
        try {
          const res: any = await ytSearch(query, youtubeOptions)
          info = await ytdl.getInfo(res.results[0].link)
        } catch (err) {
          ++this._stats.errorCount
          return reject(err)
        }
      }
      
      ++this._stats.fetchCount
      
      /**
       * Serialize the reuslt and store in Redis
       * Set an expiry date as the data from the API might get outdated eventually
       */

      this._client.set(query, JSON.stringify(info), 'EX', CacheOptions.EXPIRE_SECONDS)
      this._log(`Fetch complete, cached with EX: ${CacheOptions.EXPIRE_SECONDS}`)

      resolve(info)
    })
  }
}
