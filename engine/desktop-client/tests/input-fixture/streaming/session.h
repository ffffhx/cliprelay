#pragma once
class Session {
public:
    static Session* get() { static Session session; return &session; }
    void notifyMouseEmulationMode(bool) {}
};
