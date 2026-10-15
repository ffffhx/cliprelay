// Read ONE pixel inside our owned synthetic marker, using Desktop Duplication.
// No desktop image or unrelated window content is mapped, saved or printed.
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <cstdio>
#include <cstdlib>
using Microsoft::WRL::ComPtr;
static bool ok(HRESULT hr, const char* where) {
    if (SUCCEEDED(hr)) return true;
    std::fprintf(stderr,"%s HRESULT %08lx\n",where,(unsigned long)hr);return false;
}
int main(int argc,char** argv) {
    if(argc!=3)return 2;
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    DWORD expected=(DWORD)std::strtoul(argv[1],nullptr,10),actual=0;
    HWND fixture=(HWND)(uintptr_t)std::strtoull(argv[2],nullptr,10);
    GetWindowThreadProcessId(fixture,&actual);
    RECT rect{};
    if(actual!=expected || !IsWindowVisible(fixture) || !GetWindowRect(fixture,&rect) || rect.right-rect.left!=320 || rect.bottom-rect.top!=160)return 3;
    POINT sample{rect.left+20,rect.top+20};
    ComPtr<IDXGIFactory1> factory;
    if(!ok(CreateDXGIFactory1(IID_PPV_ARGS(&factory)),"factory"))return 4;
    for(UINT a=0;a<16;a++) {
        ComPtr<IDXGIAdapter1> adapter;if(factory->EnumAdapters1(a,&adapter)==DXGI_ERROR_NOT_FOUND)break;
        if(!adapter)continue;
        for(UINT o=0;o<32;o++) {
            ComPtr<IDXGIOutput> output;if(adapter->EnumOutputs(o,&output)==DXGI_ERROR_NOT_FOUND)break;
            if(!output)continue;
            DXGI_OUTPUT_DESC outputDesc{};if(FAILED(output->GetDesc(&outputDesc)) || !outputDesc.AttachedToDesktop || !PtInRect(&outputDesc.DesktopCoordinates,sample))continue;
            if(outputDesc.Rotation!=DXGI_MODE_ROTATION_IDENTITY)return 5;
            ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;
            if(!ok(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context),"device"))return 6;
            ComPtr<IDXGIOutput1> out1;if(!ok(output.As(&out1),"output1"))return 7;
            ComPtr<IDXGIOutputDuplication> duplication;if(!ok(out1->DuplicateOutput(device.Get(),&duplication),"duplicate"))return 8;
            ComPtr<IDXGIResource> resource;DXGI_OUTDUPL_FRAME_INFO info{};
            // A newly created duplicator may first return a pointer-only update:
            // LastPresentTime=0 and AccumulatedFrames=0 do not contain a desktop.
            bool presented=false;
            for(int attempt=0;attempt<20;attempt++) {
                HRESULT hr=duplication->AcquireNextFrame(150,&info,&resource);
                if(hr==DXGI_ERROR_WAIT_TIMEOUT)continue;
                if(!ok(hr,"acquire"))return 9;
                if(info.LastPresentTime.QuadPart!=0 && info.AccumulatedFrames>0){presented=true;break;}
                resource.Reset();duplication->ReleaseFrame();
            }
            if(!presented)return 16;
            ComPtr<ID3D11Texture2D> texture;
            if(!ok(resource.As(&texture),"texture")){duplication->ReleaseFrame();return 10;}
            D3D11_TEXTURE2D_DESC desc{};texture->GetDesc(&desc);
            if(desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM){duplication->ReleaseFrame();return 11;}
            UINT x=(UINT)(sample.x-outputDesc.DesktopCoordinates.left),y=(UINT)(sample.y-outputDesc.DesktopCoordinates.top);
            if(x>=desc.Width || y>=desc.Height){duplication->ReleaseFrame();return 12;}
            desc.Width=desc.Height=desc.MipLevels=desc.ArraySize=1;desc.Usage=D3D11_USAGE_STAGING;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.BindFlags=desc.MiscFlags=0;
            ComPtr<ID3D11Texture2D> pixel;
            if(!ok(device->CreateTexture2D(&desc,nullptr,&pixel),"pixel")){duplication->ReleaseFrame();return 13;}
            D3D11_BOX box{x,y,0,x+1,y+1,1};context->CopySubresourceRegion(pixel.Get(),0,0,0,0,texture.Get(),0,&box);
            D3D11_MAPPED_SUBRESOURCE mapped{};
            if(!ok(context->Map(pixel.Get(),0,D3D11_MAP_READ,0,&mapped),"map")){duplication->ReleaseFrame();return 14;}
            unsigned char* p=(unsigned char*)mapped.pData;
            std::printf("{\"r\":%u,\"g\":%u,\"b\":%u,\"width\":%u,\"height\":%u,\"frames\":%u,\"present\":%lld,\"protected\":%s}\n",p[2],p[1],p[0],1u,1u,info.AccumulatedFrames,info.LastPresentTime.QuadPart,info.ProtectedContentMaskedOut?"true":"false");
            context->Unmap(pixel.Get(),0);duplication->ReleaseFrame();return 0;
        }
    }
    return 15;
}
