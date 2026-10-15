// SPDX-License-Identifier: GPL-3.0-only
#include "cliprelay_input.h"
#include <cassert>
#include <iostream>
#include <thread>

static std::vector<std::uint8_t> packet(std::uint32_t epoch, unsigned op) {
  return {0,0,0,12,0x4e,0x49,0x52,0x43, std::uint8_t(epoch>>24),std::uint8_t(epoch>>16),std::uint8_t(epoch>>8),std::uint8_t(epoch),std::uint8_t(op),0,0,0};
}
int main() {
  using namespace cliprelay;
  {
    input_epoch gate;
    assert(gate.permits(0) && !gate.permits(1));
    assert(!gate.begin(1,false) && !gate.begin(2,true) && !gate.begin(0,true));
    assert(gate.begin(1,true) && !gate.permits(0));
    assert(!gate.begin(1,true) && !gate.begin(2,false));
    gate.acknowledge(2,true); assert(gate.snapshot().acknowledged == 0);
    gate.acknowledge(1,true); assert(gate.snapshot().acknowledged == 1);
    assert(!gate.permits(1) && !gate.begin(2,true));
    assert(gate.begin(2,false) && !gate.permits(2));
    gate.acknowledge(2,true); assert(gate.permits(2) && !gate.permits(0));
    assert(gate.begin(3,true) && !gate.permits(2));
    gate.acknowledge(3,true); assert(gate.begin(4,false));
    gate.acknowledge(4,true); assert(!gate.permits(2) && gate.permits(4));
    gate.close(); assert(!gate.permits(4) && !gate.begin(5,true));
  }
  {
    input_epoch gate; assert(gate.begin(1,true));
    gate.acknowledge(1,false); assert(gate.snapshot().failed && !gate.permits(0));
    assert(!gate.begin(2,false));
    input_epoch gone; assert(gone.begin(1,true)); gone.close(); gone.acknowledge(1,true);
    assert(gone.snapshot().acknowledged == 0);
  }
  {
    for (std::size_t length=0; length<16; ++length) {
      auto bytes=packet(1,1); bytes.resize(length);
      assert(parse_input(bytes).op==input_op::invalid);
    }
    auto bytes=packet(1,1); assert(parse_input(bytes).op==input_op::pause);
    bytes[12]=2; assert(parse_input(bytes).op==input_op::resume);
    bytes[12]=3; assert(parse_input(bytes).op==input_op::invalid);
    bytes[3]=20; bytes.insert(bytes.end(), {0,0,0,4,0,0,0,0});
    assert(parse_input(bytes).op==input_op::data);
    bytes[19]=5; assert(parse_input(bytes).op==input_op::invalid);
    for (auto bad : {0,4,255}) assert(parse_input(packet(1,bad)).op==input_op::invalid);
    assert(parse_input(packet(0,1)).op==input_op::invalid);
    bytes=packet(1,1); bytes[13]=1; assert(parse_input(bytes).op==input_op::invalid);
    bytes=packet(1,1); bytes.push_back(0); assert(parse_input(bytes).op==input_op::invalid);
    assert(parse_input(std::vector<std::uint8_t>{0,0,0,4,3,0,0,0}).op==input_op::legacy);
  }
  {
    input_registry registry; int a=0,b=0;
    auto first=std::make_shared<input_epoch>(), second=std::make_shared<input_epoch>();
    registry.add(&a,1,std::string(64,'a'),first); assert(registry.exclusive(first));
    registry.add(&b,2,std::string(64,'b'),second); assert(!registry.exclusive(first));
    registry.remove(&b); assert(second->snapshot().closed && registry.exclusive(first));
    auto replacement=std::make_shared<input_epoch>();
    registry.add(&a,3,std::string(64,'a'),replacement); assert(first->snapshot().closed);
    assert(!registry.exclusive(first) && registry.exclusive(replacement));
  }
  {
    input_epoch gate;
    std::thread writer([&] { for (unsigned i=1;i<=10000;++i) {assert(gate.begin(i,i%2)); gate.acknowledge(i,true);} gate.close(); });
    for (unsigned i=0;i<10000;++i) {const auto s=gate.snapshot(); assert(s.acknowledged<=s.epoch); (void)gate.permits(s.acknowledged);}
    writer.join(); assert(!gate.permits(10000));
  }
  std::cout << "5 input epoch protocol, release-boundary, lifecycle and concurrent-reader scenarios passed\n";
}
