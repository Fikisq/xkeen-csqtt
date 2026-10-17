package main
import("encoding/json";"encoding/base64";"os";"path/filepath";"github.com/xtls/xray-core/infra/conf";"github.com/xtls/xray-core/common/geodata";"google.golang.org/protobuf/proto")
func main(){
 dir,_:=os.MkdirTemp("","xray-reference-");defer os.RemoveAll(dir);os.Setenv("XRAY_LOCATION_ASSET",dir)
 sites:=&geodata.GeoSiteList{Entry:[]*geodata.GeoSite{{Code:"RU"},{Code:"YOUTUBE"}}};ips:=&geodata.GeoIPList{Entry:[]*geodata.GeoIP{{Code:"RU"}}}
 for name,v:=range map[string]proto.Message{"geosite.dat":sites,"fixture-site.dat":sites,"geoip.dat":ips,"fixture-ip.dat":ips}{b,_:=proto.Marshal(v);os.WriteFile(filepath.Join(dir,name),b,0600)}
 var cases []json.RawMessage;json.NewDecoder(os.Stdin).Decode(&cases)
 result:=[]map[string]any{}
 for _,raw:=range cases{var input conf.RouterConfig;err:=json.Unmarshal(raw,&input);var config proto.Message;if err==nil{config,err=input.Build()};row:=map[string]any{"routing":raw,"valid":err==nil};if err==nil{b,_:=(proto.MarshalOptions{Deterministic:true}).Marshal(config);row["protobuf"]=base64.StdEncoding.EncodeToString(b)};result=append(result,row)}
 json.NewEncoder(os.Stdout).Encode(result)
}