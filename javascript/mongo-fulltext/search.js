"use strict";
mft.DEBUG = true;
mft.WARNING = true;

var search = function (){
    var search = {
      // CONFIG ITEMS:
      // accessing these from the server requires several function calls;
      // they should probably be stored in a safely serialisable config object
      // that is stashed in the system.js collection (for server use) and
      // global scope locally (for client/testing use)
      //
      STEMMING: 'porter', // doesn't do anything yet
      TOKENIZING: 'basic',// doesn't do anything yet

      EXTRACTED_TERMS_FIELD: '_extracted_terms',
      INDEX_SUFFIX: '__fulltext',
      SEARCH_ALL_PSEUDO_FIELD: '$search', // magic "field name" that specifies we want a fulltext search 
                // (abusing the '$' notation somewhat, which is often for search operators)
      SEARCH_ANY_PSEUDO_FIELD: '$searchany', // magic "field name" that specifies we want a fulltext search matching any, not all
  
      // WORKHORSE VARS:
      _STEM_FUNCTION: null,
      _TOKENIZE_FUNCTION: null
    };
    
    //
    // this function is designed to be called server side only,
    // by a mapreduce run. it should never be called manually
    //
    search._indexMap = function() {
        //note `this` is bound to a document from the db, not the namespace object
        mft.debug_print('executing indexMap with');        
        mft.debug_print(this);
        var search=mft.get('search');
        var res = {};
        for (var field in indexed_fields) {
            res = {};
            res[search.EXTRACTED_TERMS_FIELD] =  search.extractFieldTokens(
                this, field, indexed_fields[field]
            );
            emit(this._id, res);
        }
    };

    //
    // this function is designed to be called server side only,
    // by a mapreduce run. it should never be called manually
    //    
    search._indexReduce = function(key, valueArray) {
        mft.debug_print('executing indexReduce for key');        
        mft.debug_print(key);
        mft.debug_print('and values');        
        mft.debug_print(valueArray);
        var extracted_terms_field = mft.get('search').EXTRACTED_TERMS_FIELD;
        var all_words_array = [];
        valueArray.forEach(function(doc) {
          all_words_array = all_words_array.concat(
              doc[extracted_terms_field] || []
          );
        });
        var doc = {};
        doc[extracted_terms_field] = all_words_array;
        return doc;
    };
    
    //
    // This JS function should never be called, except from javascript
    // clients. See note at search.mapReduceSearch
    //
    search.mapReduceIndex = function(coll_name) {
        // full_text_index a given coll
        var search = mft.get('search'); //not guaranteed to have been done!
        var index_coll_name = search.indexName(coll_name);
        var res = db.runCommand(
          { mapreduce : coll_name,
            map : search._indexMap,
            reduce : search._indexReduce,
            out : index_coll_name,
            verbose : true,
            scope: {
                indexed_fields: search.indexedFieldsAndWeights(coll_name)
            }
         }
        );
        var indexes_required = {};
        indexes_required[("value." + search.EXTRACTED_TERMS_FIELD)] =1;
        db[index_coll_name].ensureIndex(
            indexes_required,
            {background:true}
        );
        mft.debug_print(res);
    };

    //
    // this function is designed to be called server side only,
    // by a mapreduce run. it should never be called manually
    //
    search._searchMap = function() {
        mft.debug_print("in searchMap with doc: ");
        mft.debug_print(this);
        mft.debug_print("and search terms: ");
        mft.debug_print(search_terms);
        var search = mft.get('search');
        var score = search.scoreRecordAgainstQuery(this, search_terms);
        // potential optimisation: don't return very low scores
        emit(this._id, score);
    };
    
    //
    // this function is designed to be called server side only,
    // by a mapreduce run. it should never be called manually
    //
    search._searchReduce = function(key, valueArray) {
        // once again, nearly trivial reduce in our case, since record _ids here map onto record _ids proper 1:1
        //
        return valueArray[0];
    };
    
    //
    // This JS function should never be called (except from javascript
    // clients)
    // for e.g. a python application you'll have to reimplement it in python
    // since you want to call the mapreduce "naked" rather than from db.eval
    // since
    // 1) db.eval javascript execution is blocking, and
    // 2) mapreduce isn't supported from db.eval 
    // as such, this is a "reference implementation", and a testing one
    //
    search.mapReduceSearch = function(coll_name, search_query_string, query_obj) {
        // searches a given coll's index
        // return a (temporary?) coll name containing the sorted results
        //
        var search = mft.get('search');
        var search_query_terms = search.processQueryString(search_query_string);
        mft.debug_print("searching using: ");
        mft.debug_print(search_query_terms);
        var index_coll_name = search.indexName(coll_name);
        var params = { mapreduce : index_coll_name,
            map : search._searchMap,
            reduce : search._searchReduce,
            // this is a filter to ignore objects without the right term in the index - generated in a moment...
            query : {},
            // later:
            // out : "searchfun",
            scope : {search_terms: search_query_terms, coll_name: coll_name},
            verbose : true
        };
        
        // note that I've lazily assumed "$all" (i.e. AND search) here,
        // rather than "$any" (OR). Since premature generalisation leads
        // to herpes. 
        params.query[("value."+search.EXTRACTED_TERMS_FIELD)] = { $all: search_query_terms };
        
        var res = db.runCommand(params);
        mft.debug_print(res);
        
        // this is  a disposable collection, which means reads:writes are
        // in a 1:1 ratio, so indexing it may be pointless, performance-wise
        // however it may only be sorted WITHOUT an index if it is less than
        // 4 megabytes - see http://www.mongodb.org/display/DOCS/Indexes#Indexes-Using%7B%7Bsort%28%29%7D%7DwithoutanIndex
        db[res.result].ensureIndex(
            {"value.score": 1},
            {background:true}
        );
        return db[res.result].find().sort({"value.score": 1});
        // return res;
    };

    
    search.indexName = function(coll_name) {
        //calculate the collection name for the index of a given collection
        var search = mft.get('search'); 
        return coll_name + search.INDEX_SUFFIX;
    };
    
    search.indexedFieldsAndWeights = function(coll_name) {
      // we expect a special collection named 'fulltext_config', with items having elems 'collection_name', 'fields', and 'params'
      // with 'fields' having keys being the field name, and the values being the weight. e.g.:  
      //> fc = {collection_name: 'gallery_collection_items', fields: {'title': 10, 'further_information': 1}}// 
      // {
      //         "collection_name" : "gallery_collection_items",
      //         "fields" : {
      //                 "title" : 10,
      //                 "further_information" : 1
      //         }
      //         "params": {
      //            "full_vector_norm": 0
      //        }
      // }
      // > db.fulltext_config.save(fc)
      // >
      // full_vector_norm is whether to calculate all the doc vector components and normalise properly, or just guess that they're 1
        // saves time if we don't have precomputed vectors, but doesn't get quite the same results
      collection_conf = db.fulltext_config.findOne({collection_name: coll_name});
      return collection_conf.fields;
    };

    
    search.getParams = function(coll_name) {
      collection_conf = db.fulltext_config.findOne({collection_name: coll_name});
      mft.debug_print("retrieved config: " + tojson(collection_conf));
      return collection_conf.params;
    };
    
    // search.search = function(coll_name, query_obj) {
    //   // check for $search member on query_obj
    //   // if it doesn't exist, pass through to regular .find
    //   // if it does, parse the ft query string, and add the appropriate filter
    //   // clause to the non-ft-search components, execute that, then
    //   // score every remaining document, and put those sorted IDs and scores in a record in 
    //   // a private collection (hashed by the whole query obj, which we can check next time around)
    //   // then iterate through the IDs and scores and return the corresponding records with the IDs
    //   // attached to them, in a way that emulates a cursor object.
    //   var search_query_string;
    //   var require_all;
    //   if (query_obj[search.SEARCH_ALL_PSEUDO_FIELD]) {
    //     search_query_string = query_obj[search.SEARCH_ALL_PSEUDO_FIELD];
    //     require_all = true;
    //   } else if (query_obj[search.SEARCH_ALL_PSEUDO_FIELD]) {
    //     search_query_string = query_obj[search.SEARCH_ANY_PSEUDO_FIELD];
    //     require_all = false;
    //   } else {
    //     throw "No search term in search query!"; // no need to call search, you chump
    //   }
    //   mft.debug_print("query string is " + search_query_string);
    //   var query_terms = search.processQueryString(search_query_string);
    //   mft.debug_print("query terms is " + (query_terms.join(',') + " with length " + query_terms.length));
    //   query_obj[search.EXTRACTED_TERMS_FIELD] = search.filterArg(coll_name, query_terms, require_all);
    //   if (require_all) {
    //     delete(query_obj[search.SEARCH_ALL_PSEUDO_FIELD]); // need to get rid f pseudo args, as they stop .find() from returning anything
    //   } else {
    //     delete(query_obj[search.SEARCH_ANY_PSEUDO_FIELD]);
    //   }
    //   mft.debug_print("query_obj=" + tojson(query_obj));
    //   var filtered = db[coll_name].find(query_obj);
    //   var scores_and_ids = [];
    //   mft.debug_print("num recs found: " + filtered.count());
    //   filtered.forEach(
    //     function(record) {
    //       var score = search.scoreRecordAgainstQuery(coll_name, record, query_terms);
    //       scores_and_ids.push([score, record._id]);
    //     });
    //   return new search.SearchPseudoCursor(coll_name, scores_and_ids);
    //   // scores_and_ids.sort(search.sortNumericFirstDescending); // need to provide a custom search function anyway, as JS does sorts alphabetically
    //   // var scored_records = [];
    //   // // this is the dodgy way - need to do a cursor in the future
    //   // for (var i = 0; i < scores_and_ids.length; i++) {
    //   //   var score_and_id = scores_and_ids[i];
    //   //   record = db[coll_name].findOne({_id: score_and_id[1]});
    //   //   record.score = score_and_id[0];
    //   //   scored_records.push(record);
    //   // }
    //   // return scored_records;
    // };
    // 
    // 
    // search.sortNumericFirstDescending = function(a, b) {
    //   
    //   return b[0] - a[0];
    // };
    // 
    
    search.scoreRecordAgainstQuery = function(record, query_terms) {
      mft.debug_print("in scoreRecordAgainstQuery with coll_name: ");
      mft.debug_print(coll_name);
      mft.debug_print("and record: ");
      mft.debug_print(record);
      var search = mft.get("search");
      var record_terms = record.value[search.EXTRACTED_TERMS_FIELD];
      mft.debug_print("record=" + record);
      var query_terms_set = {};
      var score = 0.0;
      for (var i = 0; i < query_terms.length; i++) {
        query_terms_set[query_terms[i]] = true; // to avoid needing to iterate
      }
      mft.debug_print("query_terms_set=" + tojson(query_terms_set));

      var idf_cache = {};
      var record_vec_sum_sq = 0;
      mft.debug_print("getParams");
      mft.debug_print(search.getParams(coll_name));
      mft.debug_print("getting full_vector_norm");
      // var full_vector_norm = search.getParams(coll_name).full_vector_norm;
      var full_vector_norm = 0;
      var getCachedTermIdf = function(x) {
        var term_idf = idf_cache[term];
        if (term_idf === undefined) {
          term_idf = search.getTermIdf(coll_name, term);
          idf_cache[term] = term_idf;
        }
        return term_idf;
      };
      for (var j = 0; j < record_terms.length; j++) {
        var term = record_terms[j];
        var term_in_query = (term in query_terms_set);
        var term_idf = 0;
        if (term_in_query || full_vector_norm) {
            //begin Dan IDF Hack
            // term_idf = getCachedTermIdf(term);
            term_idf = 1;
        }
        if (term_in_query) {
            score += term_idf;
        }
        record_vec_sum_sq += full_vector_norm ? term_idf * term_idf : 1.0;
      }
      return score/Math.sqrt(record_vec_sum_sq);
      // for cosine similarity, we normalize the document vector against the sqrt of the sums of the sqares of all term
      // we also haven't divided by the magnitude of the query vector, but that is constant across docs
      // could probably take some shortcuts here w/o too much loss of accuracy
    };

    search.calcTermIdf = function(coll_name, term) { //or should this be getTermIdf?
      
      //
      // this currently doesn't have any caching smarts.
      // we could cache the IDF for each doc in the collection, but that would make updating more complicated
      // for the moment I'll gamble on mongodb being quick enough to make it not a problem
      // 
      var term_filter_obj = {};
      term_filter_obj[search.EXTRACTED_TERMS_FIELD] = search.filterArg(coll_name, [term], true);
      var term_count = db[coll_name].find(term_filter_obj).count();
      if (term_count === 0) { return 0.0; }
      var num_docs = db[coll_name].find().count(); // TODO: memoize, or find a better method for getting this
      return Math.log(num_docs) - Math.log(term_count);
    };
    

    search.getTermIdf = function(coll_name, term) {
      var score_record = db.fulltext_term_scores.findOne({collection_name: coll_name, term: term});
      mft.debug_print(score_record, "score_record");
      if (score_record === null) {
        mft.warning_print("no score cached for term " + term);
        return 0.0;
      } else {
        if (score_record.dirty) {
          mft.warning_print("score for term " + term + " may be incorrect");
        }
        return score_record.score;
      }
    };

    search.calcAndStoreTermIdf = function(coll_name, term) {
      idf_score = search.calcTermIdf(coll_name, term);
      // print("DEBUG: calculated IDF for term " + term + " as " + idf_score);
      db.fulltext_term_scores.update({collection_name: coll_name, term: term}, {$set: {score: idf_score, dirty: false}}, {upsert: true});
    };

    search.storeEmptyTermIdf = function(coll_name, term) {
      // adds the term into the index if it's not already there, but marks it as dirty
      db.fulltext_term_scores.update({collection_name: coll_name, term: term}, {$set: {dirty: true}}, {upsert: true});
    };

    search.filterArg = function(coll_name, query_terms, require_all) {
      
      if (require_all === undefined) {
        require_all = true;
      }
      var filter_obj = {};
      filter_obj[require_all ? '$all' : '$in'] = query_terms;
      return filter_obj;
    };
    
    // this needs to be implemented client-side
    search.processQueryString = function(query_string) {
        var normalised_query = search.stemAndTokenize(query_string);
        normalised_query.sort();
        return normalised_query; // maybe tokenizing should be different for queries?
    };
    
    
    // search.indexAll = function(coll_name) {
    //   
    //   mft.debug_print("indexing all records in " + coll_name);
    //   var cur = db[coll_name].find();
    //   indexed_fields = search.indexedFieldsAndWeights(coll_name);
    //   mft.debug_print("indexed fields and weights: " + tojson(indexed_fields));
    //   recs_indexed = 0;
    //   search.checkTermScoreIndex(coll_name);
    //   cur.forEach(function(x) { 
    //     search.indexSingleRecord(coll_name, x, indexed_fields, false); 
    //     recs_indexed++;
    //     if (recs_indexed % 100 === 0) {
    //       print(recs_indexed);
    //     }
    //   });
    //   search.checkExtractedTermIndex(coll_name); // maybe delete this before populating to make it quicker?
    //   mft.debug_print("Calculating IDF scores");
    //   search.fillDirtyIdfScores(coll_name);
    // };

    search.checkTermScoreIndex = function(coll_name) {
      db.fulltext_term_scores.ensureIndex({collection_name: 1, term: 1});
    };

    search.checkExtractedTermIndex = function(coll_name) {
      ext_terms_idx_criteria = [];
      ext_terms_idx_criteria[search.EXTRACTED_TERMS_FIELD] = 1;
      db[coll_name].ensureIndex(ext_terms_idx_criteria);
    };

    // search.indexSingleRecord = function(coll_name, record, indexed_fields, calculate_idf) {
    //   if (typeof indexed_fields === 'undefined') {// we can pass this in to save CPU in bulk indexing, but might not
    // 
    //     indexed_fields = search.indexedFieldsAndWeights(coll_name);
    //   }
    //   if (typeof calculate_idf === 'undefined') {
    //     calculate_idf = true; // assume we're just indexing this one doc - so we probably want to cal at the time
    //   }
    //   var all_extracted_terms = [];
    //   for (var field in indexed_fields) {    
    //     all_extracted_terms = all_extracted_terms.concat(
    //        search.extractFieldTokens(coll_name, record, field, indexed_fields[field])
    //     );
    //   }
    //   record[search.EXTRACTED_TERMS_FIELD] = all_extracted_terms;
    //   // mft.debug_print("record is now: " + tojson(record));
    // 
    //   db[coll_name].save(record);
    //   if (calculate_idf) { // if we're doing just one doc
    //     all_extracted_terms.forEach(function(x) {search.calcAndStoreTermIdf(coll_name, x);});
    //   } else { // we're doing it in bulk, so defer calcs until later
    //     all_extracted_terms.forEach(function(x) {search.storeEmptyTermIdf(coll_name, x);});
    //   }
    // };
    // 
    // 
    // search.indexSingleRecordFromId = function(coll_name, record_id) {
    //   
    //   var rec = db[coll_name].findOne({'_id': record_id});
    //   search.indexSingleRecord(coll_name, rec);
    // };

    search.fillDirtyIdfScores = function(coll_name) {
      search.checkExtractedTermIndex(coll_name);
      var cur = db.fulltext_term_scores.find({collection_name: coll_name, dirty: true});
      cur.forEach( function(x) { search.calcAndStoreTermIdf(coll_name, x.term); });
    };

    search.extractFieldTokens = function(record, field, upweighting) {
      // extracts tokens in stemmed and tokenised form and upweights them as specified in the config if necessary
      var contents = record[field];
      if (typeof contents == 'object') {
        contents = contents.join(" ");
      }
      if (!contents) { // eg the field doesn't exist on this particular record, we silently fail
        return;
      }
      var processed_contents = search.stemAndTokenize(contents);  
      if (upweighting == 1) { // special -casing for the common case - may be slightly quicker avoiding the array copy
        return processed_contents;
      } else {
        var upweighted_contents = processed_contents;
        for (var i = 1; i < upweighting; i++) {
          upweighted_contents = upweighted_contents.concat(processed_contents);
        }
        return upweighted_contents; // this upweighting shouldn't damage our scores as long as we TF IDF, since IDF won't be affect by linear multipliers
      }
    };
    
    
    search.stemAndTokenize = function(field_contents) {
      mft.debug_print("stem'n'tokenising: ");
      mft.debug_print(field_contents);
      return search.stem(search.tokenize(field_contents.toLowerCase())); //TODO: actually stem as promised
    };

    search.tokenizeBasic = function(field_contents) {
      
      var token_re = /\b(\w[\w'-]*\w|\w)\b/g;
      return field_contents.match(token_re);
    };
    
    
    search.stem = function(field_tokens) {
        
      var stem_fn = search.getStemFunction();
      var stemmed = [];
      for (var i = 0; i < field_tokens.length; i++) {
        stemmed.push(stem_fn(field_tokens[i]));
      }
      return stemmed;
    };

    search.tokenize = function(field_contents) {
      
      var tokenize_fn = search.getTokenizeFunction();
      return tokenize_fn(field_contents);
    };

    search.getStemFunction = function() {
      
      if (search._STEM_FUNCTION) {
        return search._STEM_FUNCTION;
      } else {
        if (search.STEMMING == 'porter') { // no others available
          //slightly weird invocation here to preserve consistency - get returns
          //a constructor function always
          var stemmer = null;
          stemmer = mft.get('PorterStemmer');
          return (search._STEM_FUNCTION = new stemmer()); 
        } else {
          throw "Invalid stemming function " + tojson(search.STEMMING);
        }
      }
    };

    search.getTokenizeFunction = function() {
      
      if (search._TOKENIZE_FUNCTION) {
        return search._TOKENIZE_FUNCTION;
      } else {
        if (search.TOKENIZING == 'basic') { // no others available
          return (search._TOKENIZE_FUNCTION = search.tokenizeBasic);
        }
      }  
    };

    search.SearchPseudoCursor = function(coll_name, scores_and_ids) {
      
      // class to vaguely efficiently act as a store for the the retrived records while not chewing up lots of
      // memory, and not taking lots of time to sort results we may not need - hence the heap
      this.coll_name = coll_name;
      // fetch the BinaryHeap constructor on a separate line for clarity
      
      var BinaryHeap = mft.get('BinaryHeap');
      
      var scores_and_ids_heap = new BinaryHeap(function(x) { return -x[0]; });
  
      // mft.debug_print("score function running: " + scores_and_ids_heap.scoreFunction([[1, 2], [3,1]]);
      scores_and_ids.forEach( function(x) {
        scores_and_ids_heap.push(x); // in-place would be better, but let's leave that unless we think it would be useful
      });
      this.scores_and_ids_heap = scores_and_ids_heap;


      this.hasNext = function() {
        return this.scores_and_ids_heap.size() > 0;
      };
      
      this.next = function() {
        return this.fetchScoredRecord(this.scores_and_ids_heap.pop());
      };
      
      //ATM this doesn't get called...
      //db.eval("return tojson(mftsearch.search('search_works', {$search: 'fish'}).toArray());");
      //returns a non-array (appears to be a 
      this.toArray = function() {
        output = [];
        while (this.hasNext()) {
          output.push(this.next());
        }
        return output;
      };
      
      this.fetchById = function(record_id) {
        return db[this.coll_name].findOne({_id: record_id});
      };
      
      this.fetchScoredRecord = function(score_and_id) {
        rec = this.fetchById(score_and_id[1]);
        rec.score = score_and_id[0];
        return rec;
      };
    };
    
    return search;
};

_all = {
  search: search
};
  