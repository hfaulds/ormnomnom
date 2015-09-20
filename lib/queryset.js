'use strict'

module.exports = createQueryClass()

const symbols = require('./shared-symbols.js')
const privateAPISym = symbols.privateAPI
const classToDAOSym = symbols.clsToDAO

const QueryStream = require('pg-query-stream')
const concat = require('concat-stream')
const Promise = require('bluebird')
const streams = require('stream')

const Transform = streams.Transform
const Readable = streams.Readable

const boom = require('boom')
const once = require('once')

const DELETE = Symbol('delete')
const INSERT = Symbol('insert')
const UPDATE = Symbol('update')
const SELECT = Symbol('select')
const COUNT = Symbol('count')

const daoSym = Symbol('dao')

function createQueryClass () {
  return class QuerySet {
    constructor (dao, parent) {
      this._transformer = null
      this._action = parent === null ? SELECT : null
      this._filter = null
      this._slice = null
      this._data = null
      this._order = null
      this._parent = parent
      this[daoSym] = dao
    }

    count () {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = COUNT
      return qs.valuesList(['count']).then()
    }

    order (by) {
      by = Array.isArray(by) ? by : [by]
      var qs = new QuerySet(this[daoSym], this)
      qs._order = by
      return qs
    }

    get (query) {
      return this.filter(query).slice(0, 2).then((xs) => {
        switch (xs.length) {
          case 0:
            throw boom.notFound(
              this[daoSym].modelName + ' not found'
            )
          case 2:
            throw boom.badImplementation(
              'Multiple ' + this[daoSym].modelName + '\'s returned.'
            )
        }
        return xs[0]
      })
    }

    filter (query) {
      var qs = new QuerySet(this[daoSym], this)
      qs._filter = query
      return qs
    }

    slice (start, end) {
      var qs = new QuerySet(this[daoSym], this)
      switch (arguments.length) {
        case 1:
          qs._slice = [start, Infinity]
        break
        case 2:
          qs._slice = [start, end]
        break
      }
      return qs
    }

    delete () {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = DELETE
      return qs.then()
    }
    update (data) {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = UPDATE
      qs._data = data
      return qs.then()
    }
    create (data) {
      var qs = new QuerySet(this[daoSym], this)
      qs._action = INSERT
      qs._data = data
      return qs.then(function (xs) {
        return Array.isArray(data) ? xs : xs[0]
      })
    }

    values (values) {
      var qs = new QuerySet(this[daoSym], this)
      qs._transformer = this[daoSym].createValuesTransformer(values)
      return qs
    }
    valuesList (values) {
      var qs = new QuerySet(this[daoSym], this)
      values = Array.isArray(values) ? values : [values]
      qs._transformer = this[daoSym].createValuesListTransformer(values)
      return qs
    }

    raw () {
      return materialize(this, (db, values, sql) => {
        return {db, values, sql}
      })
    }
    createStream() {
      var mapper = createMapper(this)
      materialize(this).then(function (stream) {
        stream.on('error', err => {
          mapper.emit('error', err)
        })
        stream.pipe(mapper)
      }, function (err) {
        mapper.emit('error', err)
      })
      return mapper
    }

    pipe(dst, opts) {
      return this.createStream().pipe(dst, opts)
    }
    then(onsuccess, onfail) {
      var deferred = Promise.defer()
      var reject = once(deferred.reject.bind(deferred))
      var src = this.createStream()
      var dst = concat(items => {
        deferred.resolve(items)
      })
      src.once('error', reject)
      dst.once('error', reject)
      src.pipe(dst)

      var promise = deferred.promise

      if (onsuccess && onfail) {
        promise = promise.then(onsuccess, onfail)
      } else if (onsuccess) {
        promise = promise.then(onsuccess)
      } else if (onfail) {
        promise = promise.catch(onfail)
      }

      return promise
    }
    get sql () {
      return materialize(this, (db, values, sql) => {
        return sql
      })
    }
  }
}

function *iterate (qs) {
  var current = qs
  while (current) {
    yield current
    current = current._parent
  }
}

function materialize (queryset, destination) {
  var transformer = null
  var action = null
  var order = null
  var filter = []
  var slice = []
  var data = null
  for (var xs of iterate(queryset)) {
    action = action || xs._action
    data = data || xs._data
    transformer = transformer || xs._transformer
    order = order || xs._order
    if (xs._filter) {
      filter.unshift(xs._filter)
    }
    if (xs._slice) {
      slice.unshift(xs._slice)
    }
  }

  slice.unshift([0, Infinity])
  slice = slice.reduce(function (current, next) {
    return [
      current[0] + next[0],
      Math.min(current[0] + next[1], current[1])
    ]
  }, [0, Infinity])

  var getData = action === INSERT || action === UPDATE ?
    Promise.props(data || {}) :
    Promise.cast({})

  var getWhere = Promise.all(filter.map(xs => {
    return Array.isArray(xs) ? Promise.all(xs) : Promise.props(xs)
  }))
  var connection = queryset[daoSym].getConnection()

  return Promise.all([
    getData,
    getWhere,
    connection
  ]).spread(buildQuery)

  function buildQuery (data, where, db) {
    var values = []
    var sql = null
    var result = null
    switch (action) {
      case UPDATE:
        destination = destination || queryCount
        result = buildUpdate(
          queryset[daoSym], db, data, where, slice, order, values)
        break
      case DELETE:
        destination = destination || queryCount
        result = buildDelete(
          queryset[daoSym], db, where, slice, order, values)
        break
      case SELECT:
        destination = destination || queryMap
        result = buildSelect(
          queryset[daoSym], db, where, slice, order, values)
        break
      case COUNT:
        destination = destination || queryMap
        result = buildCount(
          queryset[daoSym], db, where, slice, order, values)
        break
      case INSERT:
        destination = destination || queryMap
        result = buildInsert(
          queryset[daoSym], db, data, values)
        break
    }

    return destination(db, values, result)
  }
}

function queryCount (db, values, sql) {
  var stream = new Readable({
    objectMode: true,
    read (n) {}
  })
  db.query(sql, values, function (err, rows) {
    if (err) {
      return stream.emit('error', err)
    }
    stream.push(rows.rowCount)
    stream.push(null)
  })
  return stream
}

function queryMap (db, values, sql) {
  var query = new QueryStream(sql, values)
  return db.query(query)
}

function settleData (data) {
  return Promise.props(data)
}

function settleFilter (filter) {
  return Promise.all(
    values.map(xs => Array.isArray(xs) ? Promise.all(xs) : Promise.props(xs))
  )
}

function createMapper (queryset) {
  var transformer = null
  for (var xs of iterate(queryset)) {
    transformer = xs._transformer
    if (transformer) {
      break
    }
  }
  transformer = transformer || queryset[daoSym].createObjectTransformer()
  return new Transform({
    objectMode: true,
    transform (chunk, enc, cb) {
      transformer(chunk, out => this.push(out))
      cb()
    }
  })
}

function buildUpdate (dao, db, data, where, bounds, order, values) {
  var keys = []
  var col = null
  for (var key in data) {
    if (!dao.ddl[key]) {
      continue
    }
    var val = data[key]
    if (dao.ddl[key].isFK) {
      col = dao.ddl[key].getColumn()
    } else {
      col = dao.ddl[key]
      val = data[key].id
    }
    keys.push(col.name)
    values.push(col.toSQL(val, true))
  }

  return `
    UPDATE "${dao.tableName}"
    SET (${
      keys.map((key, idx) => {
        return '"' + key + '" = $' + (idx + 1)
      })
    })
    WHERE "${dao.tableName}"."id" IN (
      ${buildSelect(dao, db, where, bounds, order, values, onlyFields)}
    )
  `
}

function buildDelete (dao, db, where, bounds, order, values) {
  var onlyFields = [`"${dao.tableName}"."id"`]
  return `
    DELETE FROM "${dao.tableName}"
    WHERE "${dao.tableName}"."id" IN (
      ${buildSelect(dao, db, where, bounds, order, values, onlyFields)}
    )
  `
}

function buildCount (dao, db, where, bounds, order, values) {
  var onlyFields = [`COUNT(*) AS "count"`]
  return buildSelect(dao, db, where, bounds, order, values, onlyFields)
}

function buildSelect (dao, db, where, bounds, order, values, onlyFields) {
  var joinClause = []
  var selectClause = [dao.addColumns(dao.tableName)]
  var seenJoin = new Map()
  var pfx = new Map()
  var seenSelect = new Set([dao])
  pfx.set(dao, dao.tableName)
  for (var join of getJoins(dao, where, seenJoin)) {
    pfx.set(join.to, pfx.get(join.from) + '.' + join.on.name)
    joinClause.push(`LEFT JOIN "${join.to.tableName}" ON (
      "${join.from.tableName}"."${join.on.getColumn().name}" = 
      "${join.to.tableName}"."id"
    )`)
    if (!seenSelect.has(join.to)) {
      selectClause.push(join.to.addColumns(pfx.get(join.to)))
    }
    seenSelect.add(join.to)
  }

  order = (order || []).map(col => {
    var order = 'ASC'
    if (col[0] === '-') {
      col = col.slice(1)
      order = 'DESC'
    }
    var info = getColInfo(col)
    return `"${info.dao.tableName}"."${info.col.name}" ${order}`
  })

  var offset = bounds[0]
  var limit = bounds[1] - bounds[0]
  var whereClause = '(' + where.map(clause => {
    return whereClauseToSQL(dao, clause, values)
  }).join(') AND (') + ')'

  return `
    SELECT ${onlyFields || selectClause} FROM
    "${dao.tableName}"
    ${joinClause.join(' ')}
    WHERE ${whereClause}
    ${order.length ? 'ORDER BY ' + order : ''}
    LIMIT ${isFinite(limit) ? limit : 'ALL'}
    OFFSET ${offset}
  `
}

function buildInsert (dao, db, data, values) {
  var keys = []
  var col = null
  var numbers = []
  for (var key in data) {
    if (!dao.ddl[key]) {
      continue
    }
    var val = data[key]
    if (dao.ddl[key].isFK) {
      col = dao.ddl[key].getColumn()
      val = data[key].id
    } else {
      col = dao.ddl[key]
    }
    keys.push(`"${col.name}"`)
    numbers.push(values.push(col.toSQL(val, true)))
  }

  var allKeys = Object.keys(dao.ddl).filter(xs => {
    return dao.ddl[xs].isColumn
  })

  return `
    INSERT INTO "${dao.tableName}"
    (${keys}) VALUES ($${numbers.join(', $')})
    RETURNING ${allKeys.map(
      xs => '"' + xs + '" AS "' + dao.tableName + '.' + xs + '"'
    )}
  `
}

function whereClauseToSQL (dao, clause, values) {
  if (Array.isArray(clause)) {
    return '(' +
      clause.map(xs => whereClauseToSQL(dao, xs, values))
     .join(') OR (') +
    ')'
  }
  var out = []
  for (var key in clause) {
    var info = key.split(':')
    var colInfo = getColInfo(dao, info[0])
    var op = info[1]
    out.push(operationMap(
      `"${colInfo.dao.tableName}"."${colInfo.col.name}"`,
      op || 'eq',
      clause[key],
      value => values.push(colInfo.col.toSQL(value, false))
    ))
  }
  return '(' + out.join(') AND (') + ')'
}

function getColInfo (dao, colspec) {
  var bits = colspec.split('.')
  var curDao = dao
  for (var j = 0; j < bits.length - 1; ++j) {
    curDao = curDao.ddl[bits[j]].getAPI()
  }
  return {
    col: curDao.ddl[bits[j]],
    dao: curDao
  }
}

function operationMap (col, op, val, push) {
  return {
    eq () {
      return `${col} = $${push(val)}`
    },
    neq () {
      return `${col} <> $${push(val)}`
    },
    contains () {
      return `${col} like $${push('%' + val.replace(/%/g, '%%') + '%')}`
    },
    startsWith () {
      return `${col} like $${push(val.replace(/%/g, '%%') + '%')}`
    },
    endsWith () {
      return `${col} like $${push('%' + val.replace(/%/g, '%%'))}`
    },
    in () {
      if (val.length < 1) {
        return `false`
      }
      return `${col} in (${val.map(xs => push(xs))})`
    },
    notIn () {
      return `${col} not in (${val.map(xs => push(xs))})`
    },
    isNull () {
      return `${col} is ${val ? '' : 'NOT'} NULL`
    },
    lt () {
      return `${col} < $${push(val)}`
    },
    gt () {
      return `${col} > $${push(val)}`
    },
    lte () {
      return `${col} <= $${push(val)}`
    },
    gte () {
      return `${col} >= $${push(val)}`
    },
    iContains () {
      return `UPPER(${col}) like UPPER($${push('%' + val.replace(/%/g, '%%') + '%')})`
    },
    iStartsWith () {
      return `UPPER(${col}) like UPPER($${push(val.replace(/%/g, '%%') + '%')})`
    },
    iEndsWith () {
      return `UPPER(${col}) like UPPER($${push('%' + val.replace(/%/g, '%%'))})`
    },
  }[op]()
}


function *getJoins (dao, clause, seenJoin) {
  for (var i = 0; i < clause.length; ++i) {
    var subclause = clause[i]
    if (Array.isArray(subclause)) {
      for (var xs of subclause) {
        yield * getJoinFromSubclause(xs, dao, seenJoin)
      }
    } else {
      yield * getJoinFromSubclause(subclause, dao, seenJoin)
    }
  }
  return seenJoin
}

function *getJoinFromSubclause (subclause, dao, seenJoin) {
  for (var key in subclause) {
    var isNew = false
    var cols = key.split(':')[0]
    var bits = cols.split('.')
    var curDao = dao
    for (var j = 0; j < bits.length - 1; ++j) {
      if (!seenJoin.has(curDao)) {
        isNew = true
        seenJoin.set(curDao, new Map())
      }
      var next = seenJoin.get(curDao)
      var nextDao = curDao.ddl[bits[j]].getAPI()
      if (!next.has(nextDao)) {
        isNew = true
        next.set(nextDao, new Set())
      }
      if (!next.get(nextDao).has(bits[j])) {
        isNew = true
        next.get(nextDao).add(bits[j])
      }
      if (isNew) {
        yield {
          from: curDao,
          to: nextDao,
          on: curDao.ddl[bits[j]]
        }
        isNew = false
      }
      curDao = nextDao
    }
  }
}