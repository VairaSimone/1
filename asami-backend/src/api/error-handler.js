const logger=require("../lib/logger");
function errorHandler(err,req,res,next){
  logger.error({err,path:req.path,method:req.method},"request failed");
  const status=err.code==="NOT_FOUND"?404:err.code==="OPTIMISTIC_LOCK"?409:
    err.code==="OPERATION_IN_PROGRESS"?409:err.name==="ZodError"?400:500;
  res.status(status).json({error:status===500?"Internal server error":err.message,details:err.name==="ZodError"?err.issues:undefined});
}
module.exports={errorHandler};
