'use strict';
const {fault}=require('./paired-transport.cjs');
const fields=['id','clientId','certificate','enabled','address','port','overlay','overlayPort','routeId','routeReady'];
const sameRoute=(a,b)=>!!a && !!b && fields.every(key=>a[key]===b[key]);
class RoutedStore{
  constructor(base,route){this.base=base;this.route=route;}
  get data(){return this.base.data;}
  identity(){return this.base.identity();}
  hosts(){return this.base.hosts().map(host=>{
    if(!host.networkId)return host;
    const route=this.route(host.networkId);
    // Never fall back to a saved loopback address or persist the allocated port.
    const {address,port,overlay,overlayPort,routeId,...saved}=host;
    return route?{...saved,...route,routeReady:true}:host.directAddress?{...saved,address:host.directAddress,port:host.directPort,routeId:'direct:'+host.networkId,routeReady:true}:{...saved,routeReady:false};
  });}
  selected(){return this.hosts().find(host=>host.id===this.data.selected) || null;}
  add(host){if(host.networkId)throw fault('INVALID_HOST');return this.base.add(host);}
  select(id){return this.base.select(id);}
  selectLegacy(){return this.base.selectLegacy();}
  enable(id,enabled){return this.base.enable(id,enabled);}
  remove(id){return this.base.remove(id);}
  receipts(id){return this.base.receipts(id);}
}
module.exports={RoutedStore,sameRoute};
