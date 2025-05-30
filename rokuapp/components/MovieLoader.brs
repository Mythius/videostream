sub init()
    m.top.functionName = "loadContent"
    m.top.control = "run"
end sub

function loadContent()
    print "==> MovieLoader: running task for "; m.top.url

    urlTransfer = CreateObject("roUrlTransfer")
    urlTransfer.SetUrl(m.top.url)
    response = urlTransfer.GetToString()

    if response <> invalid and response <> ""
        json = ParseJson(response)
        if json <> invalid
            print "==> MovieLoader: JSON parsed successfully"
            m.top.content = json
        else
            print "==> MovieLoader: JSON parse failed"
        end if
    else
        print "==> MovieLoader: request failed or empty"
    end if
end function
