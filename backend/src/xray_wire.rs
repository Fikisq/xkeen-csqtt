// SPDX-License-Identifier: MPL-2.0
// XTLS/Xray-core protobuf schema; see LICENSE-Xray.
//! Xray 26.9.9 protobuf wire types. Field numbers follow upstream config.proto,
//! command.proto and common/geodata/geodat.proto (52a412d9e2f5).
use prost::Message;

#[derive(Clone, PartialEq, Message)]
pub struct TypedMessage {
    #[prost(string, tag = "1")]
    pub r#type: String,
    #[prost(bytes = "vec", tag = "2")]
    pub value: Vec<u8>,
}
#[derive(Clone, PartialEq, Message)]
pub struct AddRule {
    #[prost(message, optional, tag = "1")]
    pub config: Option<TypedMessage>,
    #[prost(bool, tag = "2")]
    pub should_append: bool,
}
#[derive(Clone, PartialEq, Message)]
pub struct Override {
    #[prost(string, tag = "1")]
    pub balancer_tag: String,
    #[prost(string, tag = "2")]
    pub target: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Config {
    #[prost(int32, tag = "1")]
    pub domain_strategy: i32,
    #[prost(message, repeated, tag = "2")]
    pub rule: Vec<RoutingRule>,
    #[prost(message, repeated, tag = "3")]
    pub balancing_rule: Vec<Balancer>,
}
#[derive(Clone, PartialEq, Message)]
pub struct RoutingRule {
    #[prost(oneof = "Target", tags = "1,12")]
    pub target: Option<Target>,
    #[prost(message, repeated, tag = "2")]
    pub domain: Vec<DomainRule>,
    #[prost(string, repeated, tag = "7")]
    pub user_email: Vec<String>,
    #[prost(string, repeated, tag = "8")]
    pub inbound_tag: Vec<String>,
    #[prost(string, repeated, tag = "9")]
    pub protocol: Vec<String>,
    #[prost(message, repeated, tag = "10")]
    pub ip: Vec<IpRule>,
    #[prost(message, repeated, tag = "11")]
    pub source_ip: Vec<IpRule>,
    #[prost(int32, repeated, tag = "13")]
    pub networks: Vec<i32>,
    #[prost(message, optional, tag = "14")]
    pub port_list: Option<PortList>,
    #[prost(btree_map = "string,string", tag = "15")]
    pub attributes: std::collections::BTreeMap<String, String>,
    #[prost(message, optional, tag = "16")]
    pub source_port_list: Option<PortList>,
    #[prost(message, repeated, tag = "17")]
    pub local_ip: Vec<IpRule>,
    #[prost(message, optional, tag = "18")]
    pub local_port_list: Option<PortList>,
    #[prost(string, tag = "19")]
    pub rule_tag: String,
    #[prost(message, optional, tag = "20")]
    pub vless_route_list: Option<PortList>,
    #[prost(string, repeated, tag = "21")]
    pub process: Vec<String>,
    #[prost(message, optional, tag = "22")]
    pub webhook: Option<Webhook>,
    #[prost(string, repeated, tag = "23")]
    pub local_os: Vec<String>,
}
#[derive(Clone, PartialEq, prost::Oneof)]
pub enum Target {
    #[prost(string, tag = "1")]
    Tag(String),
    #[prost(string, tag = "12")]
    BalancingTag(String),
}
#[derive(Clone, PartialEq, Message)]
pub struct Webhook {
    #[prost(string, tag = "1")]
    pub url: String,
    #[prost(uint32, tag = "2")]
    pub deduplication: u32,
    #[prost(btree_map = "string,string", tag = "3")]
    pub headers: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, PartialEq, Message)]
pub struct PortList {
    #[prost(message, repeated, tag = "1")]
    pub range: Vec<PortRange>,
}
#[derive(Clone, PartialEq, Message)]
pub struct PortRange {
    #[prost(uint32, tag = "1")]
    pub from: u32,
    #[prost(uint32, tag = "2")]
    pub to: u32,
}
#[derive(Clone, PartialEq, Message)]
pub struct Balancer {
    #[prost(string, tag = "1")]
    pub tag: String,
    #[prost(string, repeated, tag = "2")]
    pub outbound_selector: Vec<String>,
    #[prost(string, tag = "3")]
    pub strategy: String,
    #[prost(message, optional, tag = "4")]
    pub strategy_settings: Option<TypedMessage>,
    #[prost(string, tag = "5")]
    pub fallback_tag: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Weight {
    #[prost(bool, tag = "1")]
    pub regexp: bool,
    #[prost(string, tag = "2")]
    pub r#match: String,
    #[prost(float, tag = "3")]
    pub value: f32,
}
#[derive(Clone, PartialEq, Message)]
pub struct LeastLoad {
    #[prost(message, repeated, tag = "2")]
    pub costs: Vec<Weight>,
    #[prost(int64, repeated, tag = "3")]
    pub baselines: Vec<i64>,
    #[prost(int32, tag = "4")]
    pub expected: i32,
    #[prost(int64, tag = "5")]
    pub max_rtt: i64,
    #[prost(float, tag = "6")]
    pub tolerance: f32,
}
#[derive(Clone, PartialEq, Message)]
pub struct DomainRule {
    #[prost(oneof = "DomainValue", tags = "1,2")]
    pub value: Option<DomainValue>,
}
#[derive(Clone, PartialEq, prost::Oneof)]
pub enum DomainValue {
    #[prost(message, tag = "1")]
    Geosite(GeoSiteRule),
    #[prost(message, tag = "2")]
    Custom(Domain),
}
#[derive(Clone, PartialEq, Message)]
pub struct GeoSiteRule {
    #[prost(string, tag = "1")]
    pub file: String,
    #[prost(string, tag = "2")]
    pub code: String,
    #[prost(string, tag = "3")]
    pub attrs: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Domain {
    #[prost(int32, tag = "1")]
    pub r#type: i32,
    #[prost(string, tag = "2")]
    pub value: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct IpRule {
    #[prost(oneof = "IpValue", tags = "1,2")]
    pub value: Option<IpValue>,
}
#[derive(Clone, PartialEq, prost::Oneof)]
pub enum IpValue {
    #[prost(message, tag = "1")]
    Geoip(GeoIpRule),
    #[prost(message, tag = "2")]
    Custom(CidrRule),
}
#[derive(Clone, PartialEq, Message)]
pub struct GeoIpRule {
    #[prost(string, tag = "1")]
    pub file: String,
    #[prost(string, tag = "2")]
    pub code: String,
    #[prost(bool, tag = "3")]
    pub reverse_match: bool,
}
#[derive(Clone, PartialEq, Message)]
pub struct CidrRule {
    #[prost(message, optional, tag = "1")]
    pub cidr: Option<Cidr>,
    #[prost(bool, tag = "2")]
    pub reverse_match: bool,
}
#[derive(Clone, PartialEq, Message)]
pub struct Cidr {
    #[prost(bytes = "vec", tag = "1")]
    pub ip: Vec<u8>,
    #[prost(uint32, tag = "2")]
    pub prefix: u32,
}
#[derive(Clone, PartialEq, Message)]
pub struct GeoIp {
    #[prost(string, tag = "1")]
    pub code: String,
    #[prost(message, repeated, tag = "2")]
    pub cidr: Vec<Cidr>,
    #[prost(bool, tag = "3")]
    pub reverse_match: bool,
}
#[derive(Clone, PartialEq, Message)]
pub struct GeoIpList {
    #[prost(message, repeated, tag = "1")]
    pub entry: Vec<GeoIp>,
}
