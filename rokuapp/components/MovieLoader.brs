sub init()
    m.top.functionName = "loadContent"
    m.top.observeField("url", "onUrlChanged")
end sub

sub onUrlChanged()
    ' When URL changes, run the task
    if m.top.url <> invalid and m.top.url <> ""
        m.top.control = "RUN"
    end if
end sub

function loadContent()
    print "==> MovieLoader: running task for "; m.top.url

    urlTransfer = CreateObject("roUrlTransfer")
    urlTransfer.SetUrl(m.top.url)
    urlTransfer.EnableEncodings(true)
    response = urlTransfer.GetToString()

    if response <> invalid and response <> ""
        json = ParseJson(response)
        if json <> invalid
            print "==> MovieLoader: JSON parsed successfully, items: "; json.Count()
            m.top.content = json
        else
            print "==> MovieLoader: JSON parse failed"
            m.top.content = invalid
        end if
    else
        print "==> MovieLoader: request failed or empty"
        m.top.content = invalid
    end if
end function
